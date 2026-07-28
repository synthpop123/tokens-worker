/**
 * Public read API over the usage matrix — none of it requires auth (it is
 * usage data on a single-user backend), but internal device ids stay
 * private: every public row identifies devices by display name only.
 *
 * Query contract: every handler declares the parameters it supports and
 * anything else is a 400 — a filter that would otherwise be silently
 * ignored is a lie in the response. The four matrix endpoints (stats,
 * timeseries, breakdown, graph) share one filter set, so any view the
 * CLI can produce locally (per client / model / provider / device /
 * arbitrary date window) can be reproduced remotely:
 *
 *   from, to        YYYY-MM-DD inclusive bounds
 *   client, model, provider   comma-separated exact matches (raw ids)
 *   device          comma-separated device names
 *
 * List values are capped (MAX_LIST_VALUES) so the worst case stays far
 * below D1's 100-bound-parameters-per-query limit. The inventory
 * endpoints (meta, devices) take no filters; submissions takes limit.
 *
 * Model and provider rows on the aggregate endpoints (stats, timeseries,
 * breakdown) are merged under canonical ids, same as /api/site; /api/graph
 * keeps raw spellings because it doubles as the full-fidelity export, and
 * the filters above match raw ids.
 *
 * Endpoints:
 *   GET /api/stats       overview (totals + per-dimension aggregates + daily)
 *   GET /api/timeseries  interval=day|week|month|year, group=<dimension>
 *   GET /api/breakdown   by=<dim>[,<dim>...] arbitrary multi-dimension rollup
 *   GET /api/graph       TokenContributionData export (same shape as
 *                        `tokens graph`), heatmap-ready with intensity
 *   GET /api/meta        distinct dimension values + data range
 *   GET /api/devices     device inventory with per-device totals
 *   GET /api/submissions audit log
 */

import type { Env } from "./http";
import { json, CORS_HEADERS, DATE_RE } from "./http";
import { LEGACY_DEVICE_KEY, LEGACY_DEVICE_NAME } from "./payload";
import { canonicalModel, canonicalProvider, mergeRows, type ModelMetrics } from "./models";

export const METRICS_SQL = `
  sum(u.input) AS input,
  sum(u.output) AS output,
  sum(u.cache_read) AS cacheRead,
  sum(u.cache_write) AS cacheWrite,
  sum(u.reasoning) AS reasoning,
  sum(u.input + u.output + u.cache_read + u.cache_write + u.reasoning) AS tokens,
  sum(u.messages) AS messages,
  sum(u.cost) AS cost`;

/**
 * A day is active when it saw any activity. Early-2025 Cursor logs carry
 * message counts without token usage; those days count too (the CLI's own
 * summary.activeDays agrees).
 */
const ACTIVE_DAYS_SQL = `count(DISTINCT CASE
  WHEN (u.input + u.output + u.cache_read + u.cache_write + u.reasoning) > 0
    OR u.messages > 0 THEN u.date END) AS activeDays`;

/** Resolves public device names to internal ids inside filters. */
const DEVICE_NAME_SUBQUERY = (placeholders: string) =>
  `u.device_id IN (SELECT id FROM devices WHERE name IN (${placeholders}))`;

/** The filter set shared by the four matrix endpoints. */
const FILTER_PARAMS = ["from", "to", "client", "model", "provider", "device"] as const;

/**
 * Comma-list values per parameter. Generous for real use (a handful of
 * clients/devices exist) while capping the worst case at 2 date binds +
 * 4 × 20 list binds = 82, safely below D1's 100-parameter query limit.
 */
const MAX_LIST_VALUES = 20;

/**
 * Reject query parameters the endpoint would ignore. Silent ignoring is
 * the failure mode that hurts: ?client=cursor on an endpoint without
 * client filtering would return unfiltered data that looks filtered.
 */
function unsupportedParams(url: URL, supported: readonly string[]): string | null {
  const unknown = [...new Set(url.searchParams.keys())].filter((k) => !supported.includes(k));
  if (unknown.length === 0) return null;
  return `Unsupported parameter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Supported: ${
    supported.length > 0 ? supported.join(", ") : "none"
  }.`;
}

interface FilterResult {
  where: string;
  params: (string | number)[];
  /** Same filters restricted to date/device — for tables without the
   *  client/model/provider dimensions (daily_activity). */
  dateDeviceWhere: string;
  dateDeviceParams: (string | number)[];
  /** True when a client/model/provider filter narrows the usage matrix. */
  dimensionFiltered: boolean;
  error?: string;
}

const EMPTY_FILTERS: Omit<FilterResult, "error"> = {
  where: "",
  params: [],
  dateDeviceWhere: "",
  dateDeviceParams: [],
  dimensionFiltered: false,
};

function parseFilters(url: URL): FilterResult {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  const ddClauses: string[] = [];
  const ddParams: (string | number)[] = [];

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from) {
    if (!DATE_RE.test(from)) return { ...EMPTY_FILTERS, error: "from must be YYYY-MM-DD" };
    clauses.push("u.date >= ?");
    params.push(from);
    ddClauses.push("u.date >= ?");
    ddParams.push(from);
  }
  if (to) {
    if (!DATE_RE.test(to)) return { ...EMPTY_FILTERS, error: "to must be YYYY-MM-DD" };
    clauses.push("u.date <= ?");
    params.push(to);
    ddClauses.push("u.date <= ?");
    ddParams.push(to);
  }

  let dimensionFiltered = false;
  const listFilters: Array<[string, string | null, boolean]> = [
    ["client", "u.client", true],
    ["model", "u.model", true],
    ["provider", "u.provider", true],
    ["device", null, false],
  ];
  for (const [param, column, isDimension] of listFilters) {
    const raw = url.searchParams.get(param);
    if (!raw) continue;
    const values = raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    if (values.length === 0) continue;
    if (values.length > MAX_LIST_VALUES) {
      return { ...EMPTY_FILTERS, error: `${param} accepts at most ${MAX_LIST_VALUES} values` };
    }
    const placeholders = values.map(() => "?").join(", ");
    const clause = column
      ? `${column} IN (${placeholders})`
      : DEVICE_NAME_SUBQUERY(placeholders);
    clauses.push(clause);
    params.push(...values);
    if (isDimension) {
      dimensionFiltered = true;
    } else {
      ddClauses.push(clause);
      ddParams.push(...values);
    }
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
    dateDeviceWhere: ddClauses.length > 0 ? `WHERE ${ddClauses.join(" AND ")}` : "",
    dateDeviceParams: ddParams,
    dimensionFiltered,
  };
}

function cachedJson(data: unknown): Response {
  return json(data, 200, {
    "Cache-Control": "public, max-age=300",
    ...CORS_HEADERS,
  });
}

function rangeInfo(url: URL): { from: string | null; to: string | null } {
  return { from: url.searchParams.get("from"), to: url.searchParams.get("to") };
}

const byTokensDesc = (a: ModelMetrics, b: ModelMetrics) => b.tokens - a.tokens;

// ---------------------------------------------------------------------------

export async function handleStats(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const unsupported = unsupportedParams(url, FILTER_PARAMS);
  if (unsupported) return json({ error: unsupported }, 400);
  const f = parseFilters(url);
  if (f.error) return json({ error: f.error }, 400);

  const q = (sql: string) => env.DB.prepare(sql).bind(...f.params);

  const [totals, daily, byClient, byModel, byProvider, byDevice] = await env.DB.batch([
    q(`SELECT ${METRICS_SQL}, ${ACTIVE_DAYS_SQL},
         min(u.date) AS firstDate,
         max(u.date) AS lastDate
       FROM daily_usage u ${f.where}`),
    q(`SELECT u.date, ${METRICS_SQL}
       FROM daily_usage u ${f.where} GROUP BY u.date ORDER BY u.date`),
    q(`SELECT u.client, ${METRICS_SQL}
       FROM daily_usage u ${f.where} GROUP BY u.client ORDER BY tokens DESC`),
    q(`SELECT u.model, group_concat(DISTINCT u.provider) AS providers, ${METRICS_SQL}
       FROM daily_usage u ${f.where} GROUP BY u.model`),
    // Per (provider, model) so gateway rows can be re-attributed to the
    // model's vendor before merging back down to providers.
    q(`SELECT u.provider, u.model, ${METRICS_SQL}
       FROM daily_usage u ${f.where} GROUP BY u.provider, u.model`),
    q(`SELECT coalesce(nullif(trim(d.name), ''), 'Unnamed device') AS device,
         d.last_seen AS lastSeen,
         count(DISTINCT u.date) AS activeDays, ${METRICS_SQL}
       FROM daily_usage u LEFT JOIN devices d ON d.id = u.device_id
       ${f.where} GROUP BY u.device_id ORDER BY tokens DESC`),
  ]);

  const totalsRow = (totals.results[0] ?? {}) as Record<string, unknown>;
  return cachedJson({
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
    byModel: mergeRows(
      byModel.results as unknown as (ModelMetrics & { model: string })[]
    ).sort(byTokensDesc),
    byProvider: mergeRows(
      (byProvider.results as unknown as (ModelMetrics & { provider: string; model: string })[]).map(
        ({ model, ...row }) => ({ ...row, provider: canonicalProvider(row.provider, model) })
      ),
      { field: "provider", canonicalize: (id) => id }
    ).sort(byTokensDesc),
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
  device: "coalesce(nullif(trim(d.name), ''), 'Unnamed device')",
};

export async function handleTimeseries(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const unsupported = unsupportedParams(url, [...FILTER_PARAMS, "interval", "group"]);
  if (unsupported) return json({ error: unsupported }, 400);
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

  const join = group === "device" ? "LEFT JOIN devices d ON d.id = u.device_id" : "";
  // Provider series carry the model per row (dropped after use), so
  // gateway providers can be re-attributed to the model's vendor.
  const modelCol = group === "provider" ? ", u.model AS model" : "";
  const select = groupExpr
    ? `SELECT ${periodExpr} AS period, ${groupExpr} AS key${modelCol}, ${METRICS_SQL}`
    : `SELECT ${periodExpr} AS period, ${METRICS_SQL}`;
  const groupBy = groupExpr ? `GROUP BY period, key${modelCol ? ", u.model" : ""}` : `GROUP BY period`;

  const rows = await env.DB
    .prepare(`${select} FROM daily_usage u ${join} ${f.where} ${groupBy}`)
    .bind(...f.params)
    .all();

  type SeriesRow = ModelMetrics & { period: string; key?: string; model?: string };
  let series = rows.results as unknown as SeriesRow[];
  if (group === "model") {
    series = mergeRows(series, {
      field: "key",
      canonicalize: canonicalModel,
      groupBy: (row) => row.period,
    });
  } else if (group === "provider") {
    series = mergeRows(
      series.map(({ model, ...row }) => ({
        ...row,
        key: canonicalProvider(row.key ?? "", model),
      })),
      { field: "key", canonicalize: (id) => id, groupBy: (row) => row.period }
    );
  }
  series.sort((a, b) =>
    a.period === b.period ? b.tokens - a.tokens : a.period < b.period ? -1 : 1
  );

  return cachedJson({
    range: rangeInfo(url),
    interval,
    group: groupExpr ? group : null,
    series,
  });
}

// ---------------------------------------------------------------------------

const BREAKDOWN_DIMENSIONS: Record<string, string> = {
  client: "u.client AS client",
  model: "u.model AS model",
  provider: "u.provider AS provider",
  device: "coalesce(nullif(trim(d.name), ''), 'Unnamed device') AS device",
  date: "u.date AS date",
  month: "substr(u.date, 1, 7) AS month",
  year: "substr(u.date, 1, 4) AS year",
};

export async function handleBreakdown(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const unsupported = unsupportedParams(url, [...FILTER_PARAMS, "by", "limit"]);
  if (unsupported) return json({ error: unsupported }, 400);
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

  // Provider rows are re-attributed to the model's vendor before merging;
  // when the caller didn't ask for the model dimension it rides along as
  // an auxiliary column and is dropped again right after.
  const auxModel = by.includes("provider") && !by.includes("model");
  const selectDims = [
    ...by.map((dim) => BREAKDOWN_DIMENSIONS[dim]),
    ...(auxModel ? [BREAKDOWN_DIMENSIONS.model] : []),
  ].join(", ");
  const groupDims = [...by, ...(auxModel ? ["model"] : [])].join(", ");
  const join = by.includes("device") ? "LEFT JOIN devices d ON d.id = u.device_id" : "";

  const result = await env.DB
    .prepare(
      `SELECT ${selectDims}, ${METRICS_SQL}
       FROM daily_usage u ${join} ${f.where}
       GROUP BY ${groupDims}`
    )
    .bind(...f.params)
    .all();

  type BreakdownRow = ModelMetrics & Record<string, unknown>;
  let rows = result.results as unknown as BreakdownRow[];
  if (by.includes("provider")) {
    rows = rows.map(({ model, ...rest }) => {
      const provider = canonicalProvider(String(rest.provider ?? ""), String(model ?? ""));
      return (auxModel ? { ...rest, provider } : { ...rest, model, provider }) as BreakdownRow;
    });
  }
  const canonicalDims: Record<string, (raw: string) => string> = {
    model: canonicalModel,
    provider: canonicalProvider,
  };
  for (const dim of by) {
    const canonicalize = canonicalDims[dim];
    if (!canonicalize) continue;
    const others = by.filter((d) => d !== dim);
    rows = mergeRows(rows, {
      field: dim,
      canonicalize,
      groupBy: (row) => others.map((d) => String(row[d])).join("\u0000"),
    });
  }
  rows.sort(byTokensDesc);
  if (limit !== null) rows = rows.slice(0, limit);

  return cachedJson({
    range: rangeInfo(url),
    by,
    rows,
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

interface GraphUsageRow {
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

/**
 * GET /api/graph — emits the same TokenContributionData shape as the CLI's
 * `tokens graph` export (meta / summary / years / contributions with
 * per-client rows), reconstructed from the stored matrix. This makes the
 * endpoint both the heatmap data source and a full-fidelity export, so
 * model ids stay raw here.
 */
export async function handleGraph(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const unsupported = unsupportedParams(url, [...FILTER_PARAMS, "year"]);
  if (unsupported) return json({ error: unsupported }, 400);
  const year = url.searchParams.get("year");
  if (year && !/^\d{4}$/.test(year)) return json({ error: "year must be YYYY" }, 400);
  if (year) {
    url.searchParams.set("from", `${year}-01-01`);
    url.searchParams.set("to", `${year}-12-31`);
  }
  const f = parseFilters(url);
  if (f.error) return json({ error: f.error }, 400);

  const [usage, activity] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT u.date, u.client, u.model, u.provider,
                u.input, u.output, u.cache_read AS cacheRead, u.cache_write AS cacheWrite,
                u.reasoning, u.messages, u.cost
         FROM daily_usage u ${f.where}
         ORDER BY u.date, u.client, u.model, u.provider`
      )
      .bind(...f.params),
    env.DB
      .prepare(
        `SELECT u.date, sum(u.active_time_ms) AS activeTimeMs
         FROM daily_activity u ${f.dateDeviceWhere} GROUP BY u.date`
      )
      .bind(...f.dateDeviceParams),
  ]);

  // Per-day active time is a whole-device measure; attaching it to a
  // dimension-filtered view would misattribute it.
  const activeByDate = new Map<string, number>();
  if (!f.dimensionFiltered) {
    for (const r of activity.results as Array<{ date: string; activeTimeMs: number }>) {
      activeByDate.set(r.date, r.activeTimeMs);
    }
  }

  interface DayAgg {
    tokens: number;
    cost: number;
    messages: number;
    breakdown: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
    clients: Array<{
      client: string;
      modelId: string;
      providerId?: string;
      tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
      cost: number;
      messages: number;
    }>;
  }
  const days = new Map<string, DayAgg>();
  const clientsSet = new Set<string>();
  const modelsSet = new Set<string>();

  for (const r of usage.results as unknown as GraphUsageRow[]) {
    let day = days.get(r.date);
    if (!day) {
      day = {
        tokens: 0,
        cost: 0,
        messages: 0,
        breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        clients: [],
      };
      days.set(r.date, day);
    }
    const rowTokens = r.input + r.output + r.cacheRead + r.cacheWrite + r.reasoning;
    day.tokens += rowTokens;
    day.cost += r.cost;
    day.messages += r.messages;
    day.breakdown.input += r.input;
    day.breakdown.output += r.output;
    day.breakdown.cacheRead += r.cacheRead;
    day.breakdown.cacheWrite += r.cacheWrite;
    day.breakdown.reasoning += r.reasoning;
    day.clients.push({
      client: r.client,
      modelId: r.model,
      ...(r.provider !== "" ? { providerId: r.provider } : {}),
      tokens: {
        input: r.input,
        output: r.output,
        cacheRead: r.cacheRead,
        cacheWrite: r.cacheWrite,
        reasoning: r.reasoning,
      },
      cost: r.cost,
      messages: r.messages,
    });
    clientsSet.add(r.client);
    modelsSet.add(r.model);
  }

  const dates = [...days.keys()];
  const maxCost = [...days.values()].reduce((m, d) => Math.max(m, d.cost), 0);
  const totalTokens = [...days.values()].reduce((s, d) => s + d.tokens, 0);
  const totalCost = [...days.values()].reduce((s, d) => s + d.cost, 0);
  const activeDays = [...days.values()].filter((d) => d.tokens > 0 || d.messages > 0).length;

  const years = new Map<string, { totalTokens: number; totalCost: number; start: string; end: string }>();
  for (const [date, d] of days) {
    const y = date.slice(0, 4);
    const agg = years.get(y);
    if (!agg) {
      years.set(y, { totalTokens: d.tokens, totalCost: d.cost, start: date, end: date });
    } else {
      agg.totalTokens += d.tokens;
      agg.totalCost += d.cost;
      agg.end = date;
    }
  }

  return cachedJson({
    meta: {
      generatedAt: new Date().toISOString(),
      version: "tokens-worker",
      dateRange: {
        start: url.searchParams.get("from") ?? dates[0] ?? null,
        end: url.searchParams.get("to") ?? dates[dates.length - 1] ?? null,
      },
    },
    summary: {
      totalTokens,
      totalCost,
      totalDays: days.size,
      activeDays,
      averagePerDay: activeDays > 0 ? totalCost / activeDays : 0,
      maxCostInSingleDay: maxCost,
      clients: [...clientsSet].sort(),
      models: [...modelsSet].sort(),
    },
    years: [...years.entries()].map(([y, agg]) => ({
      year: y,
      totalTokens: agg.totalTokens,
      totalCost: agg.totalCost,
      range: { start: agg.start, end: agg.end },
    })),
    contributions: [...days.entries()].map(([date, d]) => ({
      date,
      totals: { tokens: d.tokens, cost: d.cost, messages: d.messages },
      intensity: intensityFor(d.cost, maxCost),
      tokenBreakdown: d.breakdown,
      clients: d.clients,
      ...(activeByDate.has(date) ? { activeTimeMs: activeByDate.get(date) } : {}),
    })),
  });
}

// ---------------------------------------------------------------------------

export async function handleMeta(request: Request, env: Env): Promise<Response> {
  const unsupported = unsupportedParams(new URL(request.url), []);
  if (unsupported) return json({ error: unsupported }, 400);
  const [clients, models, providers, devices, range, lastReport] = await env.DB.batch([
    env.DB.prepare(`SELECT DISTINCT client FROM daily_usage ORDER BY client`),
    env.DB.prepare(`SELECT DISTINCT model, provider FROM daily_usage ORDER BY model, provider`),
    env.DB.prepare(`SELECT DISTINCT provider FROM daily_usage WHERE provider != '' ORDER BY provider`),
    env.DB.prepare(`SELECT name FROM devices ORDER BY last_seen DESC`),
    env.DB.prepare(`SELECT min(date) AS start, max(date) AS end FROM daily_usage`),
    env.DB.prepare(`SELECT max(last_seen) AS lastSeen FROM devices`),
  ]);

  const rangeRow = (range.results[0] ?? {}) as { start?: string | null; end?: string | null };
  const lastSeen = (lastReport.results[0] as { lastSeen?: number | null } | undefined)?.lastSeen;

  return cachedJson({
    clients: (clients.results as Array<{ client: string }>).map((r) => r.client),
    // Raw spellings drive the model= filter; canonical shows the merged name.
    models: (models.results as Array<{ model: string; provider: string }>).map((r) => ({
      ...r,
      canonical: canonicalModel(r.model),
    })),
    providers: (providers.results as Array<{ provider: string }>).map((r) => r.provider),
    devices: (devices.results as Array<{ name: string | null }>).map(
      (r) => r.name?.trim() || "Unnamed device"
    ),
    range: { start: rangeRow.start ?? null, end: rangeRow.end ?? null },
    lastUpdatedAt: lastSeen != null ? new Date(lastSeen).toISOString() : null,
  });
}

// ---------------------------------------------------------------------------

export async function handleDevices(request: Request, env: Env): Promise<Response> {
  const unsupported = unsupportedParams(new URL(request.url), []);
  if (unsupported) return json({ error: unsupported }, 400);
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

  return cachedJson({
    devices: rows.results.map(({ id, name, ...rest }) => ({
      name:
        (typeof name === "string" && name.trim()) ||
        (id === LEGACY_DEVICE_KEY ? LEGACY_DEVICE_NAME : "Unnamed device"),
      ...rest,
      mcpServers: typeof rest.mcpServers === "string" ? JSON.parse(rest.mcpServers) : null,
    })),
  });
}

// ---------------------------------------------------------------------------

export async function handleSubmissions(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const unsupported = unsupportedParams(url, ["limit"]);
  if (unsupported) return json({ error: unsupported }, 400);
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(Math.max(limitRaw ? parseInt(limitRaw, 10) || 50 : 50, 1), 500);

  const rows = await env.DB
    .prepare(
      `SELECT s.id, coalesce(nullif(trim(d.name), ''), 'Unnamed device') AS device,
              s.received_at AS receivedAt,
              s.date_start AS dateStart, s.date_end AS dateEnd,
              s.total_tokens AS totalTokens, s.total_cost AS totalCost,
              s.row_count AS rowCount, s.changed_days AS changedDays,
              s.cli_version AS cliVersion, s.generated_at AS generatedAt,
              s.mode, s.warning_count AS warningCount
       FROM submissions s LEFT JOIN devices d ON d.id = s.device_id
       ORDER BY s.received_at DESC LIMIT ?`
    )
    .bind(limit)
    .all();

  return json({ submissions: rows.results }, 200, CORS_HEADERS);
}
