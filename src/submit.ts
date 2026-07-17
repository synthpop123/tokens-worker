/**
 * POST /api/submit — CLI-compatible write path with the official server's
 * merge semantics (see merge.ts). Also implements:
 *   DELETE /api/settings/submitted-data (tokens delete-submitted-data)
 *   GET    /api/auth/token             (tokens login --token)
 *   GET    /api/me/stats               (TUI remote tab wire contract)
 */

import type { Env } from "./http";
import { json, isAuthorized } from "./http";
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
import { ensureDailyBackup } from "./backup";

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

const INSERT_USAGE_SQL = `
INSERT INTO daily_usage
  (device_id, date, client, model, provider,
   input, output, cache_read, cache_write, reasoning, messages, cost,
   parser_revision)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
  // Statements are grouped so one day's DELETE+INSERTs never split across
  // batches: a fresh full-history upload can exceed what a single D1 batch
  // reliably handles, and if a later batch fails the already-written days
  // stay internally consistent — the next idempotent resubmit heals the rest.
  const now = Date.now();
  const groups: D1PreparedStatement[][] = [];
  let insertedRows = 0;

  for (const [date, day] of changedDays) {
    const group: D1PreparedStatement[] = [
      env.DB.prepare(`DELETE FROM daily_usage WHERE device_id = ? AND date = ?`).bind(deviceId, date),
    ];
    for (const [client, data] of day) {
      for (const [key, m] of data.models) {
        const sep = key.indexOf("\u0000");
        const model = key.slice(0, sep);
        const provider = key.slice(sep + 1);
        group.push(
          env.DB.prepare(INSERT_USAGE_SQL).bind(
            deviceId, date, client, model, provider,
            m.input, m.output, m.cacheRead, m.cacheWrite, m.reasoning,
            m.messages, m.cost, data.revision
          )
        );
        insertedRows++;
      }
    }
    groups.push(group);
  }

  // Per-day active time from the submission envelope.
  for (const day of contributions) {
    const activeTimeMs = day.activeTimeMs;
    if (activeTimeMs == null || storedActivity.get(day.date) === activeTimeMs) continue;
    groups.push([
      env.DB
        .prepare(
          `INSERT INTO daily_activity (device_id, date, active_time_ms)
           VALUES (?, ?, ?)
           ON CONFLICT (device_id, date) DO UPDATE SET
             active_time_ms = excluded.active_time_ms`
        )
        .bind(deviceId, day.date, asNonNegativeInt(activeTimeMs)),
    ]);
  }

  // Device row with envelope metadata.
  const finalGroup: D1PreparedStatement[] = [];
  const tm = payload.timeMetrics;
  const mcpServers = Array.isArray(payload.mcpServers)
    ? payload.mcpServers.filter((s): s is string => typeof s === "string" && s.length > 0)
    : null;
  finalGroup.push(
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
  finalGroup.push(
    env.DB
      .prepare(
        `INSERT INTO submissions
           (id, device_id, received_at, date_start, date_end, total_tokens,
            total_cost, row_count, changed_days, cli_version, generated_at,
            mode, warning_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        mode,
        warnings.length
      )
  );

  groups.push(finalGroup);

  // Chunk day-groups into batches, never splitting a group.
  const MAX_BATCH_STATEMENTS = 100;
  let batch: D1PreparedStatement[] = [];
  for (const group of groups) {
    if (batch.length > 0 && batch.length + group.length > MAX_BATCH_STATEMENTS) {
      await env.DB.batch(batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length > 0) await env.DB.batch(batch);

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
         coalesce(sum(input + output + cache_read + cache_write + reasoning), 0) AS totalTokens,
         coalesce(sum(cost), 0) AS totalCost,
         min(date) AS dateStart,
         max(date) AS dateEnd,
         count(DISTINCT CASE WHEN (input + output + cache_read + cache_write + reasoning) > 0
                               OR messages > 0 THEN date END) AS activeDays
       FROM daily_usage`
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
    username: env.TOKENS_USERNAME ?? null,
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
  return json({ user: { username: env.TOKENS_USERNAME ?? "self-hosted", avatarUrl: null } });
}

/** DELETE /api/settings/submitted-data — wipe everything for this account. */
export async function handleDeleteSubmittedData(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Invalid API token" }, 401);
  }
  const count = await env.DB
    .prepare(`SELECT count(*) AS n FROM submissions`)
    .first<{ n: number }>();
  const n = count?.n ?? 0;
  if (n === 0) {
    return json({ deleted: false, deletedSubmissions: 0 });
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM daily_usage`),
    env.DB.prepare(`DELETE FROM daily_activity`),
    env.DB.prepare(`DELETE FROM devices`),
    env.DB.prepare(`DELETE FROM submissions`),
  ]);
  ctx.waitUntil(refreshSiteCache(env));
  return json({ deleted: true, deletedSubmissions: n });
}

/**
 * GET /api/me/stats — stable wire contract consumed by the CLI TUI remote
 * tab (schemaVersion 1). The CLI always sends a bearer token, but this is
 * read-only usage data, so no auth is required (single-user backend).
 */
export async function handleMeStats(request: Request, env: Env): Promise<Response> {
  const [totals, days, devices] = await env.DB.batch([
    env.DB.prepare(
      `SELECT coalesce(sum(input + output + cache_read + cache_write + reasoning), 0) AS tokens,
              coalesce(sum(cost), 0) AS cost
       FROM daily_usage`
    ),
    env.DB.prepare(
      `SELECT date,
              sum(input + output + cache_read + cache_write + reasoning) AS tokens,
              sum(input) AS inputTokens,
              sum(output) AS outputTokens,
              sum(cost) AS cost
       FROM daily_usage GROUP BY date ORDER BY date`
    ),
    env.DB.prepare(`SELECT id, name, last_seen FROM devices ORDER BY last_seen DESC`),
  ]);

  const totalRow = totals.results[0] as { tokens: number; cost: number } | undefined;
  const deviceRows = devices.results as unknown as Array<{
    id: string;
    name: string | null;
    last_seen: number | null;
  }>;
  const lastSeen = deviceRows.length > 0 ? deviceRows[0].last_seen : null;

  return json({
    schemaVersion: 1,
    totalTokens: totalRow?.tokens ?? 0,
    totalCost: totalRow?.cost ?? 0,
    deviceCount: deviceRows.length,
    lastSubmittedAt: lastSeen != null ? new Date(lastSeen).toISOString() : null,
    days: days.results,
    devices: deviceRows.map((d) => ({
      id: d.id,
      displayName:
        d.name?.trim() || (d.id === LEGACY_DEVICE_KEY ? LEGACY_DEVICE_NAME : "Unnamed device"),
      lastSubmittedAt: d.last_seen != null ? new Date(d.last_seen).toISOString() : null,
    })),
  });
}
