/**
 * Public read API over the usage matrix. Every endpoint accepts the same
 * filter set, so any view the CLI can produce locally (per client / model /
 * provider / device / arbitrary date window) can be reproduced remotely:
 *
 *   from, to        YYYY-MM-DD inclusive bounds
 *   client, model, provider, device   comma-separated exact matches
 *
 * Endpoints:
 *   GET /api/stats       overview (totals + per-dimension aggregates + daily)
 *   GET /api/timeseries  interval=day|week|month|year, group=<dimension>
 *   GET /api/breakdown   by=<dim>[,<dim>...] arbitrary multi-dimension rollup
 *   GET /api/graph       contribution graph with CLI-compatible intensity
 *   GET /api/meta        distinct dimension values + data range
 *   GET /api/devices     device inventory with per-device totals
 *   GET /api/submissions audit log (bearer auth)
 */

import type { Env } from "./http";
import { json, corsHeaders, isAuthorized, DATE_RE } from "./http";
import { LEGACY_DEVICE_KEY, LEGACY_DEVICE_NAME } from "./payload";

const METRICS_SQL = `
  sum(u.input) AS input,
  sum(u.output) AS output,
  sum(u.cache_read) AS cacheRead,
  sum(u.cache_write) AS cacheWrite,
  sum(u.reasoning) AS reasoning,
  sum(u.input + u.output + u.cache_read + u.cache_write + u.reasoning) AS tokens,
  sum(u.messages) AS messages,
  sum(u.cost) AS cost`;

interface FilterResult {
  where: string;
  params: (string | number)[];
  error?: string;
}

function parseFilters(url: URL): FilterResult {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from) {
    if (!DATE_RE.test(from)) return { where: "", params: [], error: "from must be YYYY-MM-DD" };
    clauses.push("u.date >= ?");
    params.push(from);
  }
  if (to) {
    if (!DATE_RE.test(to)) return { where: "", params: [], error: "to must be YYYY-MM-DD" };
    clauses.push("u.date <= ?");
    params.push(to);
  }

  const listFilters: Array<[string, string]> = [
    ["client", "u.client"],
    ["model", "u.model"],
    ["provider", "u.provider"],
    ["device", "u.device_id"],
  ];
  for (const [param, column] of listFilters) {
    const raw = url.searchParams.get(param);
    if (!raw) continue;
    const values = raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    if (values.length === 0) continue;
    clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function cachedJson(request: Request, data: unknown): Response {
  return json(data, 200, {
    "Cache-Control": "public, max-age=300",
    ...corsHeaders(request.headers.get("Origin")),
  });
}

function rangeInfo(url: URL): { from: string | null; to: string | null } {
  return { from: url.searchParams.get("from"), to: url.searchParams.get("to") };
}

// ---------------------------------------------------------------------------

export async function handleStats(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const f = parseFilters(url);
  if (f.error) return json({ error: f.error }, 400);

  const q = (sql: string) => env.DB.prepare(sql).bind(...f.params);

  const [totals, daily, byClient, byModel, byProvider, byDevice] = await env.DB.batch([
    q(`SELECT ${METRICS_SQL},
         count(DISTINCT CASE WHEN (u.input + u.output + u.cache_read + u.cache_write + u.reasoning) > 0 THEN u.date END) AS activeDays,
         min(u.date) AS firstDate,
         max(u.date) AS lastDate
       FROM daily_usage u ${f.where}`),
    q(`SELECT u.date, ${METRICS_SQL}
       FROM daily_usage u ${f.where} GROUP BY u.date ORDER BY u.date`),
    q(`SELECT u.client, ${METRICS_SQL}
       FROM daily_usage u ${f.where} GROUP BY u.client ORDER BY tokens DESC`),
    q(`SELECT u.model, group_concat(DISTINCT u.provider) AS providers, ${METRICS_SQL}
       FROM daily_usage u ${f.where} GROUP BY u.model ORDER BY tokens DESC`),
    q(`SELECT u.provider, ${METRICS_SQL}
       FROM daily_usage u ${f.where} GROUP BY u.provider ORDER BY tokens DESC`),
    q(`SELECT u.device_id AS deviceId, d.name, d.last_seen AS lastSeen,
         count(DISTINCT u.date) AS activeDays, ${METRICS_SQL}
       FROM daily_usage u LEFT JOIN devices d ON d.id = u.device_id
       ${f.where} GROUP BY u.device_id ORDER BY tokens DESC`),
  ]);

  const totalsRow = (totals.results[0] ?? {}) as Record<string, unknown>;
  return cachedJson(request, {
    range: rangeInfo(url),
    totals: {
      input: totalsRow.input ?? 0,
      output: totalsRow.output ?? 0,
      cacheRead: totalsRow.cacheRead ?? 0,
      cacheWrite: totalsRow.cacheWrite ?? 0,
      reasoning: totalsRow.reasoning ?? 0,
      tokens: totalsRow.tokens ?? 0,
      messages: totalsRow.messages ?? 0,
      cost: totalsRow.cost ?? 0,
      activeDays: totalsRow.activeDays ?? 0,
      firstDate: totalsRow.firstDate ?? null,
      lastDate: totalsRow.lastDate ?? null,
    },
    daily: daily.results,
    byClient: byClient.results,
    byModel: byModel.results,
    byProvider: byProvider.results,
    byDevice: byDevice.results,
  });
}

// ---------------------------------------------------------------------------

const INTERVALS: Record<string, string> = {
  day: "u.date",
  week: "strftime('%Y-W%W', u.date)",
  month: "substr(u.date, 1, 7)",
  year: "substr(u.date, 1, 4)",
};

const GROUP_DIMENSIONS: Record<string, string> = {
  client: "u.client",
  model: "u.model",
  provider: "u.provider",
  device: "u.device_id",
};

export async function handleTimeseries(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const f = parseFilters(url);
  if (f.error) return json({ error: f.error }, 400);

  const interval = url.searchParams.get("interval") ?? "day";
  const periodExpr = INTERVALS[interval];
  if (!periodExpr) {
    return json({ error: `interval must be one of: ${Object.keys(INTERVALS).join(", ")}` }, 400);
  }

  const group = url.searchParams.get("group");
  const groupExpr = group && group !== "none" ? GROUP_DIMENSIONS[group] : null;
  if (group && group !== "none" && !groupExpr) {
    return json({ error: `group must be one of: none, ${Object.keys(GROUP_DIMENSIONS).join(", ")}` }, 400);
  }

  const select = groupExpr
    ? `SELECT ${periodExpr} AS period, ${groupExpr} AS key, ${METRICS_SQL}`
    : `SELECT ${periodExpr} AS period, ${METRICS_SQL}`;
  const groupBy = groupExpr ? `GROUP BY period, key ORDER BY period, tokens DESC` : `GROUP BY period ORDER BY period`;

  const rows = await env.DB
    .prepare(`${select} FROM daily_usage u ${f.where} ${groupBy}`)
    .bind(...f.params)
    .all();

  return cachedJson(request, {
    range: rangeInfo(url),
    interval,
    group: groupExpr ? group : null,
    series: rows.results,
  });
}

// ---------------------------------------------------------------------------

const BREAKDOWN_DIMENSIONS: Record<string, string> = {
  client: "u.client AS client",
  model: "u.model AS model",
  provider: "u.provider AS provider",
  device: "u.device_id AS device",
  date: "u.date AS date",
  month: "substr(u.date, 1, 7) AS month",
  year: "substr(u.date, 1, 4) AS year",
};

export async function handleBreakdown(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const f = parseFilters(url);
  if (f.error) return json({ error: f.error }, 400);

  const by = (url.searchParams.get("by") ?? "client,model")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (by.length === 0 || by.some((dim) => !BREAKDOWN_DIMENSIONS[dim])) {
    return json(
      { error: `by must be a comma-separated subset of: ${Object.keys(BREAKDOWN_DIMENSIONS).join(", ")}` },
      400
    );
  }

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 0, 1), 10000) : null;

  const selectDims = by.map((dim) => BREAKDOWN_DIMENSIONS[dim]).join(", ");
  const groupDims = by.map((dim) => dim).join(", ");

  const rows = await env.DB
    .prepare(
      `SELECT ${selectDims}, ${METRICS_SQL}
       FROM daily_usage u ${f.where}
       GROUP BY ${groupDims}
       ORDER BY tokens DESC
       ${limit ? `LIMIT ${limit}` : ""}`
    )
    .bind(...f.params)
    .all();

  return cachedJson(request, {
    range: rangeInfo(url),
    by,
    rows: rows.results,
  });
}

// ---------------------------------------------------------------------------

/** Contribution-graph intensity, same thresholds as the CLI aggregator. */
function intensityFor(cost: number, maxCost: number): number {
  if (maxCost <= 0 || cost <= 0) return 0;
  const ratio = cost / maxCost;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

export async function handleGraph(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const year = url.searchParams.get("year");
  if (year && !/^\d{4}$/.test(year)) return json({ error: "year must be YYYY" }, 400);
  if (year) {
    url.searchParams.set("from", `${year}-01-01`);
    url.searchParams.set("to", `${year}-12-31`);
  }
  const f = parseFilters(url);
  if (f.error) return json({ error: f.error }, 400);

  const rows = await env.DB
    .prepare(
      `SELECT u.date, ${METRICS_SQL}
       FROM daily_usage u ${f.where} GROUP BY u.date ORDER BY u.date`
    )
    .bind(...f.params)
    .all<{
      date: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
      tokens: number;
      messages: number;
      cost: number;
    }>();

  const days = rows.results;
  const maxCost = days.reduce((m, d) => Math.max(m, d.cost), 0);

  const years = new Map<string, { totalTokens: number; totalCost: number; start: string; end: string }>();
  for (const d of days) {
    const y = d.date.slice(0, 4);
    const agg = years.get(y);
    if (!agg) {
      years.set(y, { totalTokens: d.tokens, totalCost: d.cost, start: d.date, end: d.date });
    } else {
      agg.totalTokens += d.tokens;
      agg.totalCost += d.cost;
      agg.end = d.date;
    }
  }

  return cachedJson(request, {
    range: rangeInfo(url),
    contributions: days.map((d) => ({
      date: d.date,
      totals: { tokens: d.tokens, cost: d.cost, messages: d.messages },
      tokenBreakdown: {
        input: d.input,
        output: d.output,
        cacheRead: d.cacheRead,
        cacheWrite: d.cacheWrite,
        reasoning: d.reasoning,
      },
      intensity: intensityFor(d.cost, maxCost),
    })),
    years: [...years.entries()].map(([y, agg]) => ({
      year: y,
      totalTokens: agg.totalTokens,
      totalCost: agg.totalCost,
      range: { start: agg.start, end: agg.end },
    })),
  });
}

// ---------------------------------------------------------------------------

export async function handleMeta(request: Request, env: Env): Promise<Response> {
  const [clients, models, providers, devices, range] = await env.DB.batch([
    env.DB.prepare(`SELECT DISTINCT client FROM daily_usage ORDER BY client`),
    env.DB.prepare(`SELECT DISTINCT model, provider FROM daily_usage ORDER BY model, provider`),
    env.DB.prepare(`SELECT DISTINCT provider FROM daily_usage WHERE provider != '' ORDER BY provider`),
    env.DB.prepare(`SELECT id, name FROM devices ORDER BY last_seen DESC`),
    env.DB.prepare(
      `SELECT min(date) AS start, max(date) AS end, max(updated_at) AS lastUpdatedAt FROM daily_usage`
    ),
  ]);

  const rangeRow = (range.results[0] ?? {}) as {
    start?: string | null;
    end?: string | null;
    lastUpdatedAt?: number | null;
  };

  return cachedJson(request, {
    clients: (clients.results as Array<{ client: string }>).map((r) => r.client),
    models: models.results,
    providers: (providers.results as Array<{ provider: string }>).map((r) => r.provider),
    devices: devices.results,
    range: { start: rangeRow.start ?? null, end: rangeRow.end ?? null },
    lastUpdatedAt: rangeRow.lastUpdatedAt != null ? new Date(rangeRow.lastUpdatedAt).toISOString() : null,
  });
}

// ---------------------------------------------------------------------------

export async function handleDevices(request: Request, env: Env): Promise<Response> {
  const rows = await env.DB
    .prepare(
      `SELECT d.id, d.name, d.first_seen AS firstSeen, d.last_seen AS lastSeen,
              d.cli_version AS cliVersion, d.total_active_time_ms AS totalActiveTimeMs,
              d.longest_continuous_ms AS longestContinuousMs,
              d.max_concurrent_sessions AS maxConcurrentSessions,
              d.session_count AS sessionCount, d.mcp_servers AS mcpServers,
              coalesce(sum(u.input + u.output + u.cache_read + u.cache_write + u.reasoning), 0) AS tokens,
              coalesce(sum(u.messages), 0) AS messages,
              coalesce(sum(u.cost), 0) AS cost,
              count(DISTINCT u.date) AS activeDays,
              min(u.date) AS firstDate,
              max(u.date) AS lastDate
       FROM devices d LEFT JOIN daily_usage u ON u.device_id = d.id
       GROUP BY d.id ORDER BY d.last_seen DESC`
    )
    .all<Record<string, unknown>>();

  return cachedJson(request, {
    devices: rows.results.map((d) => ({
      ...d,
      displayName:
        (typeof d.name === "string" && d.name.trim()) ||
        (d.id === LEGACY_DEVICE_KEY ? LEGACY_DEVICE_NAME : "Unnamed device"),
      mcpServers: typeof d.mcpServers === "string" ? JSON.parse(d.mcpServers) : null,
    })),
  });
}

// ---------------------------------------------------------------------------

export async function handleSubmissions(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Invalid API token" }, 401);
  }
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(Math.max(limitRaw ? parseInt(limitRaw, 10) || 50 : 50, 1), 500);

  const rows = await env.DB
    .prepare(
      `SELECT id, device_id AS deviceId, received_at AS receivedAt,
              date_start AS dateStart, date_end AS dateEnd,
              total_tokens AS totalTokens, total_cost AS totalCost,
              row_count AS rowCount, cli_version AS cliVersion,
              generated_at AS generatedAt, mode, warning_count AS warningCount
       FROM submissions ORDER BY received_at DESC LIMIT ?`
    )
    .bind(limit)
    .all();

  return json({ submissions: rows.results });
}
