/**
 * GET /api/site — the one-request view backing lkwplus.com/tokens.
 *
 * Everything the dashboard needs, precomposed: totals and per-dimension
 * breakdowns for the four ranges it offers (7 / 30 / 90 days / all time,
 * range boundaries computed here so client and server always agree on
 * "today"), the full daily series split by provider AND by client (for the
 * stacked trend chart's two stacking modes, the weekday profile and the
 * heatmap) with per-day active time where the CLI reported it, and the
 * device inventory with CLI metadata (version, sessions, active-time
 * totals, MCP servers). Every breakdown row (model / client / provider)
 * also carries its usage span — distinct active days plus first/last date
 * inside the range. Model rows are merged under canonical names (see
 * models.ts). "Active" days count messages too: early-2025 Cursor logs
 * carry message counts but no token usage, and those days really were
 * active.
 *
 * Serving path: the payload lives in KV, refreshed on every accepted
 * submission (the only event that changes the data — the account's cron
 * quota is full), so requests never wait on D1 — cold and hot paths alike
 * are a single KV read. A day-rollover guard recomposes when no device
 * has reported since midnight. Composition itself is one D1 batch of
 * three statements: the per-day usage matrix (a few thousand rows at
 * personal scale), daily activity, and the device inventory; all four
 * ranges are aggregated here in JS.
 */

import type { Env } from "./http";
import { corsHeaders, isoToday } from "./http";
import { canonicalModel } from "./models";

const CACHE_SECONDS = 300;
const STALE_SECONDS = 3600;
// Bump on shape changes so a fresh deploy recomposes instead of serving
// the previous schema out of KV until the next submission.
export const SITE_KEY = "site-v2";

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

interface UsageRow extends Metrics {
  date: string;
  client: string;
  model: string;
  provider: string;
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

interface DaySlice {
  tokens: number;
  cost: number;
}

interface SiteDay {
  date: string;
  tokens: number;
  cost: number;
  messages: number;
  /** Per-day active time (ms) summed across devices; present only where
   *  the CLI reported it. */
  active?: number;
  providers: Record<string, DaySlice>;
  clients: Record<string, DaySlice>;
}

/** Shift an ISO day by whole days; anchoring at noon UTC is DST-proof. */
function shiftDays(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function emptyMetrics(): Metrics {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    tokens: 0,
    messages: 0,
    cost: 0,
  };
}

function addMetrics(target: Metrics, row: Metrics): void {
  target.input += row.input;
  target.output += row.output;
  target.cacheRead += row.cacheRead;
  target.cacheWrite += row.cacheWrite;
  target.reasoning += row.reasoning;
  target.tokens += row.tokens;
  target.messages += row.messages;
  target.cost += row.cost;
}

/** Distinct active dates of one breakdown entry, serialized as a span. */
interface DateSpan {
  dates: Set<string>;
}

function spanOf({ dates }: DateSpan) {
  const sorted = [...dates].sort();
  return {
    days: sorted.length,
    firstDate: sorted[0] ?? null,
    lastDate: sorted[sorted.length - 1] ?? null,
  };
}

/** One range's aggregation state, filled row by row. */
class RangeAgg {
  totals = emptyMetrics();
  byModel = new Map<string, Metrics & DateSpan & { model: string; providers: Set<string> }>();
  byClient = new Map<string, Metrics & DateSpan & { client: string }>();
  byProvider = new Map<string, Metrics & DateSpan & { provider: string }>();
  days = new Map<string, { tokens: number; messages: number }>();

  constructor(readonly from: string | null) {}

  add(row: UsageRow, model: string): void {
    addMetrics(this.totals, row);

    let m = this.byModel.get(model);
    if (!m) {
      m = { ...emptyMetrics(), model, providers: new Set(), dates: new Set() };
      this.byModel.set(model, m);
    }
    addMetrics(m, row);
    m.dates.add(row.date);
    if (row.provider) m.providers.add(row.provider);

    let c = this.byClient.get(row.client);
    if (!c) {
      c = { ...emptyMetrics(), client: row.client, dates: new Set() };
      this.byClient.set(row.client, c);
    }
    addMetrics(c, row);
    c.dates.add(row.date);

    let p = this.byProvider.get(row.provider);
    if (!p) {
      p = { ...emptyMetrics(), provider: row.provider, dates: new Set() };
      this.byProvider.set(row.provider, p);
    }
    addMetrics(p, row);
    p.dates.add(row.date);

    let day = this.days.get(row.date);
    if (!day) {
      day = { tokens: 0, messages: 0 };
      this.days.set(row.date, day);
    }
    day.tokens += row.tokens;
    day.messages += row.messages;
  }

  serialize() {
    const dates = [...this.days.keys()].sort();
    let activeDays = 0;
    for (const day of this.days.values()) {
      if (day.tokens > 0 || day.messages > 0) activeDays++;
    }
    const byTokensDesc = (a: Metrics, b: Metrics) => b.tokens - a.tokens;
    return {
      from: this.from,
      totals: {
        ...this.totals,
        activeDays,
        firstDate: dates[0] ?? null,
        lastDate: dates[dates.length - 1] ?? null,
      },
      byModel: [...this.byModel.values()].sort(byTokensDesc).map(({ providers, dates, ...rest }) => ({
        ...rest,
        providers: [...providers].join(","),
        ...spanOf({ dates }),
      })),
      byClient: [...this.byClient.values()]
        .sort(byTokensDesc)
        .map(({ dates, ...rest }) => ({ ...rest, ...spanOf({ dates }) })),
      byProvider: [...this.byProvider.values()]
        .sort(byTokensDesc)
        .map(({ dates, ...rest }) => ({ ...rest, ...spanOf({ dates }) })),
    };
  }
}

/** Compose the full /api/site JSON from D1 (one batch, three statements). */
export async function composeSiteBody(env: Env): Promise<string> {
  const today = isoToday();

  const [usage, activity, deviceRows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.date, u.client, u.model, u.provider,
              sum(u.input) AS input, sum(u.output) AS output,
              sum(u.cache_read) AS cacheRead, sum(u.cache_write) AS cacheWrite,
              sum(u.reasoning) AS reasoning,
              sum(u.input + u.output + u.cache_read + u.cache_write + u.reasoning) AS tokens,
              sum(u.messages) AS messages, sum(u.cost) AS cost
       FROM daily_usage u
       GROUP BY u.date, u.client, u.model, u.provider
       ORDER BY u.date`
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

  const aggs = RANGES.map(
    ({ days }) => new RangeAgg(days ? shiftDays(today, 1 - days) : null)
  );
  const daily = new Map<string, SiteDay>();
  const dayFor = (date: string): SiteDay => {
    let day = daily.get(date);
    if (!day) {
      day = { date, tokens: 0, cost: 0, messages: 0, providers: {}, clients: {} };
      daily.set(date, day);
    }
    return day;
  };
  const addSlice = (slices: Record<string, DaySlice>, key: string, row: UsageRow) => {
    const slot = slices[key] ?? { tokens: 0, cost: 0 };
    slot.tokens += row.tokens;
    slot.cost += row.cost;
    slices[key] = slot;
  };

  for (const row of usage.results as unknown as UsageRow[]) {
    const model = canonicalModel(row.model);
    for (const agg of aggs) {
      if (agg.from === null || row.date >= agg.from) agg.add(row, model);
    }
    const day = dayFor(row.date);
    day.tokens += row.tokens;
    day.cost += row.cost;
    day.messages += row.messages;
    if (row.tokens > 0 || row.cost > 0) {
      addSlice(day.providers, row.provider || "unknown", row);
      addSlice(day.clients, row.client || "unknown", row);
    }
  }

  for (const row of activity.results as unknown as DailyActivityRow[]) {
    if (!row.active || row.active <= 0) continue;
    dayFor(row.date).active = row.active;
  }

  const ranges: Record<string, unknown> = {};
  RANGES.forEach(({ key }, i) => {
    ranges[key] = aggs[i].serialize();
  });

  const devices = (deviceRows.results as unknown as DeviceRow[]).map((device) => ({
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

  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    today,
    ranges,
    daily: [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    devices,
  });
}

/** Store a composed payload; the composition day rides along as metadata
 *  so the read path can detect day rollover without parsing the body. */
function putSiteCache(env: Env, body: string): Promise<void> {
  return env.SITE_CACHE.put(SITE_KEY, body, { metadata: { today: isoToday() } });
}

/** Recompute the site payload and store it in KV. */
export async function refreshSiteCache(env: Env): Promise<string> {
  const body = await composeSiteBody(env);
  await putSiteCache(env, body);
  return body;
}

export async function handleSite(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
    // stale-while-revalidate: after the 5 minutes, browsers reuse the
    // stale copy instantly and refetch in the background.
    "Cache-Control": `public, max-age=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`,
  };
  const withCors = (response: Response): Response => {
    const out = new Response(response.body, response);
    for (const [key, value] of Object.entries(corsHeaders(request.headers.get("Origin")))) {
      out.headers.set(key, value);
    }
    // cache.match rewrites Cache-Control to the zone's Browser Cache TTL
    // (a day), which would let browsers pin stale payloads — restate ours.
    out.headers.set("Cache-Control", headers["Cache-Control"]);
    return out;
  };

  // Two cache tiers, no D1 on either: the PoP-local edge cache (~10 ms,
  // 5-minute TTL), then KV (~50 ms hot, a few hundred ms on a cold PoP —
  // rewritten by every accepted submission). The cached entry itself
  // stays origin-neutral; CORS is attached per-request after lookup.
  const cacheKey = new Request(new URL("/api/site", request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  // Recompose inline only when the KV entry is missing (first deploy) or
  // was composed on a previous calendar day and no device has reported
  // since midnight (range windows must slide anyway).
  const { value, metadata } = await env.SITE_CACHE.getWithMetadata<{ today?: string }>(SITE_KEY);
  let body = value;
  if (body === null || metadata?.today !== isoToday()) {
    body = await composeSiteBody(env);
    ctx.waitUntil(putSiteCache(env, body));
  }
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers })));
  return withCors(new Response(body, { headers }));
}
