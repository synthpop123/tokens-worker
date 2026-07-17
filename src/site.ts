/**
 * GET /api/site — the one-request view backing lkwplus.com/tokens.
 *
 * Everything the dashboard needs, precomposed: totals and per-dimension
 * breakdowns for the four ranges it offers (7 / 30 / 90 days / all time,
 * range boundaries computed here so client and server always agree on
 * "today"), the full daily series split by provider (for the stacked trend
 * chart, weekday profile and heatmap) with per-day active time where the
 * CLI reported it, and the device inventory with CLI metadata (version,
 * sessions, active-time totals, MCP servers). Model rows are merged under
 * canonical names (see models.ts) — the raw spellings stay visible on
 * /api/stats.
 *
 * Cached in the edge cache for 5 minutes on top of the D1 aggregation, so
 * page loads normally never touch the database.
 */

import type { Env } from "./http";
import { corsHeaders } from "./http";
import { METRICS_SQL } from "./read";
import { canonicalModel } from "./models";

const TIME_ZONE = "Asia/Shanghai";
const CACHE_SECONDS = 300;
const RANGES = [
  { key: "week", days: 7 },
  { key: "month", days: 30 },
  { key: "quarter", days: 90 },
  { key: "all", days: null },
] as const;

interface Metrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  tokens: number;
  messages: number;
  cost: number;
}

interface ModelRow extends Metrics {
  model: string;
  providers: string | null;
}

interface DailyProviderRow {
  date: string;
  provider: string;
  tokens: number;
  cost: number;
  messages: number;
}

interface DailyActivityRow {
  date: string;
  active: number | null;
}

interface DeviceRow {
  name: string | null;
  firstSeen: number | null;
  lastSeen: number | null;
  cliVersion: string | null;
  sessions: number | null;
  activeMs: number | null;
  longestMs: number | null;
  maxConcurrent: number | null;
  mcpServers: string | null;
  activeDays: number;
  tokens: number | null;
  messages: number | null;
  cost: number | null;
}

interface SiteDay {
  date: string;
  tokens: number;
  cost: number;
  messages: number;
  /** Per-day active time (ms) summed across devices; present only where
   *  the CLI reported it. */
  active?: number;
  providers: Record<string, { tokens: number; cost: number }>;
}

const isoDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Shift an ISO day by whole days; anchoring at noon UTC is DST-proof. */
function shiftDays(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Merge per-effort model rows under their canonical names. */
function mergeModels(rows: ModelRow[]): ModelRow[] {
  const merged = new Map<string, ModelRow>();
  for (const row of rows) {
    const model = canonicalModel(row.model);
    const target = merged.get(model);
    if (!target) {
      merged.set(model, { ...row, model });
      continue;
    }
    target.input += row.input;
    target.output += row.output;
    target.cacheRead += row.cacheRead;
    target.cacheWrite += row.cacheWrite;
    target.reasoning += row.reasoning;
    target.tokens += row.tokens;
    target.messages += row.messages;
    target.cost += row.cost;
    const providers = new Set(
      [target.providers, row.providers]
        .flatMap((list) => (list ?? "").split(","))
        .filter((provider) => provider.length > 0)
    );
    target.providers = [...providers].join(",");
  }
  return [...merged.values()].sort((a, b) => b.tokens - a.tokens);
}

export async function handleSite(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = request.headers.get("Origin");
  const withCors = (response: Response): Response => {
    const out = new Response(response.body, response);
    for (const [key, value] of Object.entries(corsHeaders(origin))) {
      out.headers.set(key, value);
    }
    return out;
  };

  // CORS headers are attached per-request after lookup, so the cached
  // entry itself stays origin-neutral. The version tag busts the edge
  // cache whenever the payload shape changes — bump it alongside any
  // schema change so a fresh deploy serves fresh JSON immediately.
  const cacheKey = new Request(new URL("/api/site?v=2", request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  const today = isoDay.format(new Date());

  const rangeStatements = RANGES.flatMap(({ days }) => {
    const where = days ? "WHERE u.date >= ?" : "";
    const bind = (sql: string) => {
      const statement = env.DB.prepare(sql);
      return days ? statement.bind(shiftDays(today, 1 - days)) : statement;
    };
    return [
      bind(`SELECT ${METRICS_SQL},
              count(DISTINCT CASE WHEN (u.input + u.output + u.cache_read + u.cache_write + u.reasoning) > 0 THEN u.date END) AS activeDays,
              min(u.date) AS firstDate,
              max(u.date) AS lastDate
            FROM daily_usage u ${where}`),
      bind(`SELECT u.model, group_concat(DISTINCT u.provider) AS providers, ${METRICS_SQL}
            FROM daily_usage u ${where} GROUP BY u.model ORDER BY tokens DESC`),
      bind(`SELECT u.client, ${METRICS_SQL}
            FROM daily_usage u ${where} GROUP BY u.client ORDER BY tokens DESC`),
      bind(`SELECT u.provider, ${METRICS_SQL}
            FROM daily_usage u ${where} GROUP BY u.provider ORDER BY tokens DESC`),
    ];
  });

  const results = await env.DB.batch([
    ...rangeStatements,
    env.DB.prepare(
      `SELECT u.date, u.provider,
              sum(u.input + u.output + u.cache_read + u.cache_write + u.reasoning) AS tokens,
              sum(u.messages) AS messages,
              sum(u.cost) AS cost
       FROM daily_usage u GROUP BY u.date, u.provider ORDER BY u.date`
    ),
    env.DB.prepare(
      `SELECT u.date, sum(u.active_time_ms) AS active
       FROM daily_activity u GROUP BY u.date ORDER BY u.date`
    ),
    env.DB.prepare(
      `SELECT d.name, d.first_seen AS firstSeen, d.last_seen AS lastSeen,
              d.cli_version AS cliVersion, d.session_count AS sessions,
              d.total_active_time_ms AS activeMs,
              d.longest_continuous_ms AS longestMs,
              d.max_concurrent_sessions AS maxConcurrent,
              d.mcp_servers AS mcpServers,
              count(DISTINCT u.date) AS activeDays,
              sum(u.input + u.output + u.cache_read + u.cache_write + u.reasoning) AS tokens,
              sum(u.messages) AS messages,
              sum(u.cost) AS cost
       FROM devices d LEFT JOIN daily_usage u ON u.device_id = d.id
       GROUP BY d.id ORDER BY d.last_seen DESC`
    ),
  ]);
  const base = RANGES.length * 4;

  const ranges: Record<string, unknown> = {};
  RANGES.forEach(({ key, days }, i) => {
    const [totals, byModel, byClient, byProvider] = results.slice(i * 4, i * 4 + 4);
    // sum() over zero rows yields nulls — normalize so the client can trust
    // the numbers.
    const t = (totals.results[0] ?? {}) as Record<string, unknown>;
    ranges[key] = {
      from: days ? shiftDays(today, 1 - days) : null,
      totals: {
        input: t.input ?? 0,
        output: t.output ?? 0,
        cacheRead: t.cacheRead ?? 0,
        cacheWrite: t.cacheWrite ?? 0,
        reasoning: t.reasoning ?? 0,
        tokens: t.tokens ?? 0,
        messages: t.messages ?? 0,
        cost: t.cost ?? 0,
        activeDays: t.activeDays ?? 0,
        firstDate: t.firstDate ?? null,
        lastDate: t.lastDate ?? null,
      },
      byModel: mergeModels(byModel.results as unknown as ModelRow[]),
      byClient: byClient.results,
      byProvider: byProvider.results,
    };
  });

  // Pivot (date, provider) rows into one entry per day with a provider map.
  const daily = new Map<string, SiteDay>();
  const dayFor = (date: string): SiteDay => {
    let day = daily.get(date);
    if (!day) {
      day = { date, tokens: 0, cost: 0, messages: 0, providers: {} };
      daily.set(date, day);
    }
    return day;
  };
  for (const row of results[base].results as unknown as DailyProviderRow[]) {
    const day = dayFor(row.date);
    day.tokens += row.tokens;
    day.cost += row.cost;
    day.messages += row.messages;
    if (row.tokens > 0 || row.cost > 0) {
      const provider = row.provider || "unknown";
      const slot = day.providers[provider] ?? { tokens: 0, cost: 0 };
      slot.tokens += row.tokens;
      slot.cost += row.cost;
      day.providers[provider] = slot;
    }
  }
  for (const row of results[base + 1].results as unknown as DailyActivityRow[]) {
    if (!row.active || row.active <= 0) continue;
    dayFor(row.date).active = row.active;
  }

  const devices = (results[base + 2].results as unknown as DeviceRow[]).map((device) => ({
    name: device.name?.trim() || "Unnamed device",
    firstSeen: device.firstSeen,
    lastSeen: device.lastSeen,
    cliVersion: device.cliVersion,
    sessions: device.sessions,
    activeMs: device.activeMs,
    longestMs: device.longestMs,
    maxConcurrent: device.maxConcurrent,
    mcpServers:
      typeof device.mcpServers === "string" ? (JSON.parse(device.mcpServers) as string[]) : null,
    activeDays: device.activeDays,
    tokens: device.tokens ?? 0,
    messages: device.messages ?? 0,
    cost: device.cost ?? 0,
  }));

  const body = JSON.stringify({
    generatedAt: new Date().toISOString(),
    today,
    ranges,
    daily: [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    devices,
  });
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
  };
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers })));
  return withCors(new Response(body, { headers }));
}
