/**
 * tokens-usage — self-hosted backend for the `tokens` CLI (missuo/tokens).
 *
 * Implements the one endpoint the CLI actually needs (`POST /api/submit`,
 * Bearer auth) plus a read-side `GET /api/stats` for the personal site.
 *
 * The CLI submits a full rescan of local logs every time, so writes are
 * idempotent max()-guarded upserts keyed by (device, date, client, model,
 * provider): re-submits are no-ops, and a rescan that shrank because local
 * session logs were cleaned up can never erase history already stored here.
 */

export interface Env {
  DB: D1Database;
  TOKENS_API_TOKEN: string;
}

interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

interface ClientContribution {
  client: string;
  modelId: string;
  providerId?: string;
  tokens: TokenBreakdown;
  cost: number;
  messages: number;
}

interface DailyContribution {
  date: string;
  totals: { tokens: number; cost: number; messages: number };
  clients: ClientContribution[];
}

interface SubmissionPayload {
  meta?: { dateRange?: { start?: string; end?: string } };
  device?: { id?: string; name?: string };
  summary?: { totalTokens?: number; totalCost?: number; activeDays?: number };
  contributions?: DailyContribution[];
}

const ALLOWED_ORIGINS = [
  "https://lkwplus.com",
  "https://www.lkwplus.com",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin !== null &&
    (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin));
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

/** Constant-time bearer token check (compares SHA-256 digests). */
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match || !env.TOKENS_API_TOKEN) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(match[1])),
    crypto.subtle.digest("SHA-256", enc.encode(env.TOKENS_API_TOKEN)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

function asNonNegativeInt(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : 0;
}

function asNonNegativeNumber(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return n >= 0 ? n : 0;
}

interface UsageRow {
  deviceId: string;
  date: string;
  client: string;
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  messages: number;
  cost: number;
}

function extractRows(payload: SubmissionPayload, deviceId: string): { rows: UsageRow[]; errors: string[] } {
  const errors: string[] = [];
  const byKey = new Map<string, UsageRow>();

  const contributions = payload.contributions;
  if (!Array.isArray(contributions)) {
    return { rows: [], errors: ["contributions must be an array"] };
  }

  for (const day of contributions) {
    if (!day || typeof day.date !== "string" || !DATE_RE.test(day.date)) {
      errors.push(`invalid contribution date: ${JSON.stringify(day?.date)}`);
      continue;
    }
    if (!Array.isArray(day.clients)) continue;

    for (const c of day.clients) {
      if (!c || typeof c.client !== "string" || typeof c.modelId !== "string") {
        errors.push(`day ${day.date}: malformed client row`);
        continue;
      }
      const provider = typeof c.providerId === "string" ? c.providerId : "";
      const key = [deviceId, day.date, c.client, c.modelId, provider].join("\u0000");
      const existing = byKey.get(key);
      const tokens = c.tokens ?? ({} as TokenBreakdown);
      const row: UsageRow = existing ?? {
        deviceId,
        date: day.date,
        client: c.client,
        model: c.modelId,
        provider,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        messages: 0,
        cost: 0,
      };
      row.input += asNonNegativeInt(tokens.input);
      row.output += asNonNegativeInt(tokens.output);
      row.cacheRead += asNonNegativeInt(tokens.cacheRead);
      row.cacheWrite += asNonNegativeInt(tokens.cacheWrite);
      row.reasoning += asNonNegativeInt(tokens.reasoning);
      row.messages += asNonNegativeInt(c.messages);
      row.cost += asNonNegativeNumber(c.cost);
      byKey.set(key, row);
    }
  }

  return { rows: [...byKey.values()], errors };
}

const UPSERT_SQL = `
INSERT INTO daily_usage
  (device_id, date, client, model, provider,
   input, output, cache_read, cache_write, reasoning, messages, cost, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
ON CONFLICT (device_id, date, client, model, provider) DO UPDATE SET
  input       = max(input, excluded.input),
  output      = max(output, excluded.output),
  cache_read  = max(cache_read, excluded.cache_read),
  cache_write = max(cache_write, excluded.cache_write),
  reasoning   = max(reasoning, excluded.reasoning),
  messages    = max(messages, excluded.messages),
  cost        = max(cost, excluded.cost),
  updated_at  = excluded.updated_at
`;

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  let payload: SubmissionPayload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const deviceId = payload.device?.id?.trim() || "unknown";
  const deviceName = payload.device?.name?.trim() || null;
  const { rows, errors } = extractRows(payload, deviceId);

  if (rows.length === 0) {
    return json(
      { error: "No usable usage rows in submission", details: errors.slice(0, 20) },
      errors.length > 0 ? 400 : 200
    );
  }

  const now = Date.now();
  const submissionId = crypto.randomUUID();

  const statements: D1PreparedStatement[] = rows.map((r) =>
    env.DB.prepare(UPSERT_SQL).bind(
      r.deviceId, r.date, r.client, r.model, r.provider,
      r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning,
      r.messages, r.cost, now
    )
  );

  statements.push(
    env.DB.prepare(
      `INSERT INTO devices (id, name, first_seen, last_seen) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (id) DO UPDATE SET
         name = coalesce(excluded.name, name),
         last_seen = excluded.last_seen`
    ).bind(deviceId, deviceName, now)
  );

  const dates = rows.map((r) => r.date).sort();
  statements.push(
    env.DB.prepare(
      `INSERT INTO submissions
         (id, device_id, received_at, date_start, date_end, total_tokens, total_cost, row_count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      submissionId,
      deviceId,
      now,
      dates[0],
      dates[dates.length - 1],
      asNonNegativeInt(payload.summary?.totalTokens),
      asNonNegativeNumber(payload.summary?.totalCost),
      rows.length
    )
  );

  await env.DB.batch(statements);

  return json({
    submissionId,
    metrics: {
      totalTokens: asNonNegativeInt(payload.summary?.totalTokens),
      totalCost: asNonNegativeNumber(payload.summary?.totalCost),
      activeDays: asNonNegativeInt(payload.summary?.activeDays),
    },
    warnings: errors.length > 0 ? errors.slice(0, 20) : undefined,
  });
}

const TOKEN_SUM = "(input + output + cache_read + cache_write + reasoning)";

async function handleStats(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return json({ error: "from/to must be YYYY-MM-DD" }, 400);
  }

  const where = "WHERE date >= ?1 AND date <= ?2";
  const lo = from ?? "0000-00-00";
  const hi = to ?? "9999-99-99";

  const [totals, daily, byClient, byModel, byDevice] = await env.DB.batch([
    env.DB.prepare(
      `SELECT
         coalesce(sum(${TOKEN_SUM}), 0) AS tokens,
         coalesce(sum(input), 0) AS input,
         coalesce(sum(output), 0) AS output,
         coalesce(sum(cache_read), 0) AS cacheRead,
         coalesce(sum(cache_write), 0) AS cacheWrite,
         coalesce(sum(reasoning), 0) AS reasoning,
         coalesce(sum(messages), 0) AS messages,
         coalesce(sum(cost), 0) AS cost,
         count(DISTINCT date) AS activeDays
       FROM daily_usage ${where}`
    ).bind(lo, hi),
    env.DB.prepare(
      `SELECT date,
         sum(${TOKEN_SUM}) AS tokens,
         sum(cost) AS cost,
         sum(messages) AS messages
       FROM daily_usage ${where} GROUP BY date ORDER BY date`
    ).bind(lo, hi),
    env.DB.prepare(
      `SELECT client,
         sum(${TOKEN_SUM}) AS tokens,
         sum(cost) AS cost,
         sum(messages) AS messages
       FROM daily_usage ${where} GROUP BY client ORDER BY tokens DESC`
    ).bind(lo, hi),
    env.DB.prepare(
      `SELECT model,
         sum(${TOKEN_SUM}) AS tokens,
         sum(cost) AS cost,
         sum(messages) AS messages
       FROM daily_usage ${where} GROUP BY model ORDER BY tokens DESC`
    ).bind(lo, hi),
    env.DB.prepare(
      `SELECT u.device_id AS deviceId, d.name,
         sum(${TOKEN_SUM}) AS tokens,
         sum(u.cost) AS cost,
         d.last_seen AS lastSeen
       FROM daily_usage u LEFT JOIN devices d ON d.id = u.device_id
       ${where.replace(/date/g, "u.date")} GROUP BY u.device_id ORDER BY tokens DESC`
    ).bind(lo, hi),
  ]);

  return json(
    {
      range: { from: from ?? null, to: to ?? null },
      totals: totals.results[0],
      daily: daily.results,
      byClient: byClient.results,
      byModel: byModel.results,
      byDevice: byDevice.results,
    },
    200,
    {
      "Cache-Control": "public, max-age=300",
      ...corsHeaders(request.headers.get("Origin")),
    }
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("Origin")) });
    }

    if (url.pathname === "/api/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    if (url.pathname === "/api/stats" && request.method === "GET") {
      return handleStats(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({ service: "tokens-usage", ok: true });
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
