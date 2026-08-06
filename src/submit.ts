/**
 * POST /api/submit — CLI-compatible write path with the official server's
 * merge semantics (see merge.ts). Also implements:
 *   DELETE /api/settings/submitted-data (tokens delete-submitted-data)
 *   GET    /api/auth/token             (tokens login --token)
 */

import type { Env } from "./http";
import { json, isAuthorized } from "./http";
import { ACTIVE_DAYS_SQL, TOKENS_SQL } from "./metrics";
import type { SubmissionPayload } from "./payload";
import {
  normalizePayload,
  validatePayload,
  asNonNegativeInt,
  asNonNegativeNumber,
  LEGACY_DEVICE_KEY,
  LEGACY_DEVICE_NAME,
} from "./payload";
import type { DeviceState, DayState } from "./merge";
import {
  aggregateIncomingDay,
  collectSubmittedClients,
  daysEqual,
  deriveRevisionFloors,
  extractCoverages,
  mergeDay,
  modelKey,
} from "./merge";
import { refreshSiteCache } from "./site";
import { ensureDailyBackup, wipeArchive } from "./backup";

interface StoredUsageRow {
  date: string;
  client: string;
  model: string;
  provider: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  messages: number;
  cost: number;
  parser_revision: number;
}

interface StoredActivityRow {
  date: string;
  active_time_ms: number;
}

function buildStoredState(rows: StoredUsageRow[]): DeviceState {
  const state: DeviceState = new Map();
  for (const r of rows) {
    let day = state.get(r.date);
    if (!day) {
      day = new Map();
      state.set(r.date, day);
    }
    let client = day.get(r.client);
    if (!client) {
      client = { revision: r.parser_revision, models: new Map() };
      day.set(r.client, client);
    }
    client.revision = Math.max(client.revision, r.parser_revision);
    client.models.set(modelKey(r.model, r.provider), {
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      reasoning: r.reasoning,
      messages: r.messages,
      cost: r.cost,
    });
  }
  return state;
}

/**
 * Set-based writes: changed rows travel as one JSON parameter and are
 * expanded server-side with json_each, so the statement count stays
 * constant no matter how many days a submission changes. D1 caps queries
 * per Worker invocation (50 on the Free plan, counted per statement —
 * splitting into more batches does not reset it), which per-row SQL would
 * exceed on any full-history first upload. `value ->> N` extracts the
 * N-th column of each JSON row.
 */
const INSERT_USAGE_SQL = `
INSERT INTO daily_usage
  (device_id, date, client, model, provider,
   input, output, cache_read, cache_write, reasoning, messages, cost,
   parser_revision)
SELECT ?1,
       value ->> 0, value ->> 1, value ->> 2, value ->> 3,
       value ->> 4, value ->> 5, value ->> 6, value ->> 7,
       value ->> 8, value ->> 9, value ->> 10, value ->> 11
FROM json_each(?2)`;

const DELETE_USAGE_SQL = `
DELETE FROM daily_usage
WHERE device_id = ?1 AND date IN (SELECT value FROM json_each(?2))`;

/** WHERE true disambiguates the upsert clause after INSERT ... SELECT. */
const UPSERT_ACTIVITY_SQL = `
INSERT INTO daily_activity (device_id, date, active_time_ms)
SELECT ?1, value ->> 0, value ->> 1 FROM json_each(?2) WHERE true
ON CONFLICT (device_id, date) DO UPDATE SET
  active_time_ms = excluded.active_time_ms`;

/** Rows per INSERT statement — bounds the JSON parameter comfortably
 *  below D1's 2 MB per-value cap (~120 bytes/row × 5000 ≈ 600 KB). */
const USAGE_ROWS_PER_STATEMENT = 5000;

/** How long the submission audit log keeps a row. Long enough to answer
 *  "is every device still reporting on cadence", short enough that the
 *  table stays flat instead of growing forever (see the DELETE below). */
const AUDIT_RETENTION_DAYS = 30;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function handleSubmit(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Invalid API token" }, 401);
  }

  const rawBody = await request.text();
  let payload: SubmissionPayload;
  try {
    payload = JSON.parse(rawBody) as SubmissionPayload;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  normalizePayload(payload);
  const { errors, warnings } = validatePayload(payload);
  if (errors.length > 0) {
    return json({ error: "Validation failed", details: errors.slice(0, 50) }, 400);
  }
  const contributions = payload.contributions ?? [];
  if (contributions.length === 0) {
    return json({ error: "No contribution data to submit" }, 400);
  }

  const deviceId = payload.device?.id?.trim() || LEGACY_DEVICE_KEY;
  const deviceName =
    payload.device?.name?.trim() ||
    (deviceId === LEGACY_DEVICE_KEY ? LEGACY_DEVICE_NAME : null);

  // ---- Read stored state for this device --------------------------------
  const [usageRes, activityRes] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT date, client, model, provider, input, output, cache_read,
                cache_write, reasoning, messages, cost, parser_revision
         FROM daily_usage WHERE device_id = ?`
      )
      .bind(deviceId),
    env.DB
      .prepare(`SELECT date, active_time_ms FROM daily_activity WHERE device_id = ?`)
      .bind(deviceId),
  ]);
  const storedRows = usageRes.results as unknown as StoredUsageRow[];
  const stored = buildStoredState(storedRows);
  const storedActivity = new Map<string, number>();
  for (const m of activityRes.results as unknown as StoredActivityRow[]) {
    storedActivity.set(m.date, m.active_time_ms);
  }

  const mode = storedRows.length === 0 ? "create" : "merge";
  const floors = deriveRevisionFloors(stored);
  const submittedClients = collectSubmittedClients(payload.summary?.clients, contributions);
  const coverages = extractCoverages(payload.clientManifest?.clients);

  // ---- Merge day by day ---------------------------------------------------
  const rejectedClients = new Set<string>();
  const changedDays = new Map<string, DayState>();
  const incomingDates = new Set<string>();

  for (const day of contributions) {
    incomingDates.add(day.date);
    const incoming = aggregateIncomingDay(day.clients);

    for (const [client, data] of incoming) {
      const floor = floors.get(client) ?? 1;
      if (data.revision < floor) {
        if (!rejectedClients.has(client)) {
          warnings.push(
            `Rejected ${client}: parser revision ${data.revision} is older than stored revision ${floor}.`
          );
          rejectedClients.add(client);
        }
      }
    }

    const { merged, warnings: dayWarnings } = mergeDay(
      day.date,
      stored.get(day.date),
      incoming,
      submittedClients,
      rejectedClients,
      coverages
    );
    warnings.push(...dayWarnings);
    if (!daysEqual(stored.get(day.date), merged)) changedDays.set(day.date, merged);
  }

  // Stored days absent from this submission: authoritative coverage may
  // tombstone clients whose local logs no longer mention those dates.
  if (coverages.length > 0) {
    for (const [date, storedDay] of stored) {
      if (incomingDates.has(date)) continue;
      const { merged, warnings: dayWarnings } = mergeDay(
        date,
        storedDay,
        undefined,
        submittedClients,
        rejectedClients,
        coverages
      );
      warnings.push(...dayWarnings);
      if (!daysEqual(storedDay, merged)) changedDays.set(date, merged);
    }
  }

  // ---- Plan writes --------------------------------------------------------
  // Everything lands in one D1 batch — one transaction, so a submission
  // either applies fully or not at all. Set-based statements (see
  // INSERT_USAGE_SQL) keep the batch a handful of queries even for a
  // full-history first upload.
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  // One JSON row per (client, model, provider) of every changed day,
  // column order matching INSERT_USAGE_SQL after the leading device_id.
  const changedDates: string[] = [];
  const usageRows: (string | number)[][] = [];
  for (const [date, day] of changedDays) {
    changedDates.push(date);
    for (const [client, data] of day) {
      for (const [key, m] of data.models) {
        const sep = key.indexOf("\u0000");
        usageRows.push([
          date, client, key.slice(0, sep), key.slice(sep + 1),
          m.input, m.output, m.cacheRead, m.cacheWrite, m.reasoning,
          m.messages, m.cost, data.revision,
        ]);
      }
    }
  }
  const insertedRows = usageRows.length;

  if (changedDates.length > 0) {
    statements.push(
      env.DB.prepare(DELETE_USAGE_SQL).bind(deviceId, JSON.stringify(changedDates))
    );
  }
  for (const rows of chunk(usageRows, USAGE_ROWS_PER_STATEMENT)) {
    statements.push(env.DB.prepare(INSERT_USAGE_SQL).bind(deviceId, JSON.stringify(rows)));
  }

  // Per-day active time from the submission envelope.
  const activityRows: [string, number][] = [];
  for (const day of contributions) {
    if (day.activeTimeMs == null) continue;
    const activeTimeMs = asNonNegativeInt(day.activeTimeMs);
    if (storedActivity.get(day.date) !== activeTimeMs) {
      activityRows.push([day.date, activeTimeMs]);
    }
  }
  if (activityRows.length > 0) {
    statements.push(
      env.DB.prepare(UPSERT_ACTIVITY_SQL).bind(deviceId, JSON.stringify(activityRows))
    );
  }

  // Device row with envelope metadata.
  const tm = payload.timeMetrics;
  const mcpServers = Array.isArray(payload.mcpServers)
    ? payload.mcpServers.filter((s): s is string => typeof s === "string" && s.length > 0)
    : null;
  statements.push(
    env.DB
      .prepare(
        `INSERT INTO devices
           (id, name, first_seen, last_seen, cli_version, total_active_time_ms,
            longest_continuous_ms, max_concurrent_sessions, session_count, mcp_servers)
         VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (id) DO UPDATE SET
           name = coalesce(excluded.name, name),
           last_seen = excluded.last_seen,
           cli_version = coalesce(excluded.cli_version, cli_version),
           total_active_time_ms = coalesce(excluded.total_active_time_ms, total_active_time_ms),
           longest_continuous_ms = coalesce(excluded.longest_continuous_ms, longest_continuous_ms),
           max_concurrent_sessions = coalesce(excluded.max_concurrent_sessions, max_concurrent_sessions),
           session_count = coalesce(excluded.session_count, session_count),
           mcp_servers = coalesce(excluded.mcp_servers, mcp_servers)`
      )
      .bind(
        deviceId,
        deviceName,
        now,
        payload.meta?.version ?? null,
        tm ? asNonNegativeInt(tm.totalActiveTimeMs) : null,
        tm ? asNonNegativeInt(tm.longestContinuousMs) : null,
        tm ? asNonNegativeInt(tm.maxConcurrentSessions) : null,
        tm ? asNonNegativeInt(tm.sessionCount) : null,
        mcpServers && mcpServers.length > 0 ? JSON.stringify(mcpServers) : null
      )
  );

  // Audit row.
  const submissionId = crypto.randomUUID();
  const dates = contributions.map((d) => d.date).sort();
  statements.push(
    env.DB
      .prepare(
        `INSERT INTO submissions
           (id, device_id, received_at, date_start, date_end, total_tokens,
            total_cost, row_count, changed_days, cli_version, generated_at,
            mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        submissionId,
        deviceId,
        now,
        dates[0],
        dates[dates.length - 1],
        asNonNegativeInt(payload.summary?.totalTokens),
        asNonNegativeNumber(payload.summary?.totalCost),
        insertedRows,
        changedDays.size,
        payload.meta?.version ?? null,
        payload.meta?.generatedAt ?? null,
        mode
      )
  );
  // Retention, in the same transaction as the row it balances. The audit
  // log answers "did the last report land, and how often do they come" —
  // a question only about recent history, while the table itself grows
  // ~80 rows a day forever (over 80% of them no-ops: devices rescan every
  // 30 minutes whether or not anything changed). Unbounded it also
  // dominated the daily R2 export, which copies whatever it finds *every
  // day* — quadratic storage growth for a log nobody reads past a week.
  statements.push(
    env.DB
      .prepare(`DELETE FROM submissions WHERE received_at < ?`)
      .bind(now - AUDIT_RETENTION_DAYS * 86_400_000)
  );

  await env.DB.batch(statements);

  // Archive the accepted payload verbatim. Submissions are full rescans,
  // so the latest one per device reproduces its whole history — enough to
  // replay-rebuild after a schema change (daily R2 exports cover the rest).
  ctx.waitUntil(
    env.ARCHIVE.put(`raw/${deviceId}/latest.json`, rawBody, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { submissionId, receivedAt: String(now) },
    })
  );

  // Submissions are the only event that changes the data, so they drive
  // the KV site payload and the daily R2 export directly (the account's
  // cron quota is full; devices report every 30 minutes anyway).
  ctx.waitUntil(refreshSiteCache(env));
  ctx.waitUntil(ensureDailyBackup(env));

  // ---- Account-wide metrics for the response (official recalculates) -----
  const metrics = await env.DB
    .prepare(
      `SELECT
         coalesce(sum(${TOKENS_SQL}), 0) AS totalTokens,
         coalesce(sum(u.cost), 0) AS totalCost,
         min(u.date) AS dateStart,
         max(u.date) AS dateEnd,
         ${ACTIVE_DAYS_SQL}
       FROM daily_usage u`
    )
    .first<{
      totalTokens: number;
      totalCost: number;
      dateStart: string | null;
      dateEnd: string | null;
      activeDays: number;
    }>();
  const clientRows = await env.DB
    .prepare(`SELECT DISTINCT client FROM daily_usage ORDER BY client`)
    .all<{ client: string }>();

  return json({
    success: true,
    submissionId,
    username: env.TOKENS_USERNAME,
    metrics: {
      totalTokens: metrics?.totalTokens ?? 0,
      totalCost: metrics?.totalCost ?? 0,
      dateRange: { start: metrics?.dateStart ?? null, end: metrics?.dateEnd ?? null },
      activeDays: metrics?.activeDays ?? 0,
      clients: clientRows.results.map((r) => r.client),
    },
    mode,
    warnings: warnings.length > 0 ? warnings.slice(0, 50) : undefined,
  });
}

/** GET /api/auth/token — token validation used by `tokens login --token`. */
export async function handleAuthToken(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Invalid API token" }, 401);
  }
  return json({ user: { username: env.TOKENS_USERNAME, avatarUrl: null } });
}

/**
 * DELETE /api/settings/submitted-data — wipe everything for this account,
 * across all three stores: the four D1 tables, every R2 object (raw
 * payload archives and daily exports reproduce submitted data, so they
 * go too), the reported quota snapshot, and the precomposed KV site
 * payload, which is recomposed synchronously so the public dashboard
 * never serves deleted data after the CLI has been told the deletion
 * succeeded. Runs unconditionally, so a retry completes whatever a
 * failed earlier attempt left behind.
 */
export async function handleDeleteSubmittedData(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Invalid API token" }, 401);
  }
  const count = await env.DB
    .prepare(`SELECT count(*) AS n FROM submissions`)
    .first<{ n: number }>();
  const n = count?.n ?? 0;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM daily_usage`),
    env.DB.prepare(`DELETE FROM daily_activity`),
    env.DB.prepare(`DELETE FROM devices`),
    env.DB.prepare(`DELETE FROM submissions`),
  ]);
  await wipeArchive(env);
  await refreshSiteCache(env, null);
  return json({ deleted: n > 0, deletedSubmissions: n });
}
