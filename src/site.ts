/**
 * GET /api/site — the one-request view backing lkwplus.com/tokens.
 *
 * Everything the dashboard needs, precomposed: totals and per-dimension
 * breakdowns for the five ranges it offers (today / 7 / 30 / 90 days /
 * all time, with the range boundaries computed here so client and server
 * always agree on "today" — `day` is the single-day window backing the
 * dashboard's Today section, and the only place a per-model split of one
 * calendar day exists; the daily series below carries client and provider
 * slices but no models), the full daily series split by provider *and* by
 * client (the trend chart's two stacking modes, the weekday profile, the
 * heatmap) with per-day active time where the CLI reported it, and the
 * device inventory with its CLI metadata. Every breakdown row also carries
 * its usage span — distinct active days plus first/last date in range.
 * Model and provider ids are canonicalized (see models.ts) *before* any
 * aggregation, so the daily provider slices agree with the provider
 * breakdown. Active days count messages too: early-2025 Cursor logs carry
 * message counts but no token usage, and those days really were active.
 *
 * The whole payload is a view *as of today*: every statement below is
 * bounded by the collector's current calendar day. Submissions may
 * legitimately carry dates up to two days ahead (payload.ts keeps the
 * official clock-skew allowance, and a device in a timezone east of
 * Asia/Shanghai really is a day ahead for part of the evening), but a
 * row dated tomorrow has nowhere to go in a dashboard whose windows all
 * end today — left unbounded it would land in "Today" next to an active
 * time that is filtered by exact date, and the section would contradict
 * itself. Such rows stay in D1 and join the payload when their day
 * arrives; the day-rollover guard below guarantees the recomposition.
 *
 * Serving path: the payload lives in KV, rewritten by every accepted
 * submission — the only event that changes the data — so cold and hot
 * requests alike are a single KV read and never wait on D1. Freshness is
 * event-driven, never TTL-guessed: responses carry `Cache-Control:
 * no-cache` plus a strong ETag (SHA-256 of the body, computed once at
 * composition time and stored in KV metadata), so browsers keep a copy but
 * always revalidate — a ~0-byte 304 while the data is unchanged, the new
 * payload the moment it isn't. The only staleness left is KV's own per-PoP
 * cache (cacheTtl, 30 s), plus a day-rollover guard for when no device has
 * reported since midnight. Composition is one D1 batch of three
 * statements; all five ranges are then aggregated in JS.
 */

import type { Env } from "./http";
import { CORS_HEADERS, isoToday } from "./http";
import {
  METRICS_SQL,
  TOKENS_SQL,
  addMetrics,
  byTokensDesc,
  emptyMetrics,
  type Metrics,
} from "./metrics";
import { canonicalModel, canonicalProvider } from "./models";

// The KV key never changes; the schema version rides in the response body
// (as `schemaVersion`, the cross-repo contract the homepage validates and
// keys its cache by) and in the KV metadata (so a fresh deploy recomposes
// on first read instead of serving the previous schema out of KV until
// the next submission). Bump SITE_VERSION on any shape or semantics
// change, and keep the homepage's SITE_SCHEMA_VERSION plus its committed
// /api/site fixture (homepage: src/lib/client/tokens.ts + .test.ts) in
// lockstep.
const SITE_KEY = "site";
export const SITE_VERSION = 6;
/** How long a PoP may serve its local copy of the KV entry before
 *  re-checking central storage — the global worst-case staleness after
 *  a submission rewrites the payload (30 is the API's minimum). */
const KV_CACHE_TTL = 30;

const RANGES = [
  { key: "day", days: 1 },
  { key: "week", days: 7 },
  { key: "month", days: 30 },
  { key: "quarter", days: 90 },
  { key: "all", days: null },
] as const;

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

/**
 * The per-day slice maps are keyed by client and provider ids that came
 * straight from a CLI payload, so they carry no prototype. On a plain
 * object an id spelled `constructor` or `__proto__` resolves an inherited
 * value instead of a fresh slot, and the slice then disappears from the
 * JSON while the day total still counts it — silent under-reporting in the
 * dashboard's stacked chart, at HTTP 200. A Map would work too, but these
 * serialize straight into the response as JSON objects.
 */
const emptySlices = (): Record<string, DaySlice> => Object.create(null);

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

/** A breakdown entry accumulates its distinct active dates, serialized as
 *  a span (days + first/last) once the range is complete. */
type Entry<T> = Metrics & T & { dates: Set<string> };

/** Fold one usage row into the entry for `key`, creating it on first sight. */
function fold<T>(map: Map<string, Entry<T>>, key: string, row: UsageRow, id: () => T): Entry<T> {
  let entry = map.get(key);
  if (!entry) {
    entry = { ...emptyMetrics(), ...id(), dates: new Set() } as Entry<T>;
    map.set(key, entry);
  }
  addMetrics(entry, row);
  entry.dates.add(row.date);
  return entry;
}

/** Sort by tokens, then trade the date set for its serialized span. */
function serializeEntries<T>(map: Map<string, Entry<T>>) {
  return [...map.values()].sort(byTokensDesc).map(({ dates, ...rest }) => {
    const sorted = [...dates].sort();
    return {
      ...rest,
      days: sorted.length,
      firstDate: sorted[0] ?? null,
      lastDate: sorted[sorted.length - 1] ?? null,
    };
  });
}

/** One range's aggregation state, filled row by row. */
class RangeAgg {
  totals = emptyMetrics();
  byModel = new Map<string, Entry<{ model: string; providers: Set<string> }>>();
  byClient = new Map<string, Entry<{ client: string }>>();
  byProvider = new Map<string, Entry<{ provider: string }>>();
  days = new Map<string, { tokens: number; messages: number }>();

  constructor(readonly from: string | null) {}

  add(row: UsageRow, model: string): void {
    addMetrics(this.totals, row);

    const entry = fold(this.byModel, model, row, () => ({ model, providers: new Set<string>() }));
    if (row.provider) entry.providers.add(row.provider);
    fold(this.byClient, row.client, row, () => ({ client: row.client }));
    fold(this.byProvider, row.provider, row, () => ({ provider: row.provider }));

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
    return {
      from: this.from,
      totals: {
        ...this.totals,
        activeDays,
        firstDate: dates[0] ?? null,
        lastDate: dates[dates.length - 1] ?? null,
      },
      byModel: serializeEntries(this.byModel).map(({ providers, ...rest }) => ({
        ...rest,
        providers: [...providers].join(","),
      })),
      byClient: serializeEntries(this.byClient),
      byProvider: serializeEntries(this.byProvider),
    };
  }
}

/** Compose the full /api/site JSON from D1 (one batch, three statements). */
export async function composeSiteBody(env: Env): Promise<string> {
  const today = isoToday();

  // `u.date <= ?1` on all three statements is the one place the
  // as-of-today bound is enforced (see the header): ranges, the daily
  // series and the device inventory then agree by construction, without
  // every aggregation having to remember an upper bound. On the device
  // join it belongs in the ON clause — a WHERE would turn the LEFT JOIN
  // inner and drop devices that have only reported future-dated rows.
  const [usage, activity, deviceRows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.date, u.client, u.model, u.provider, ${METRICS_SQL}
       FROM daily_usage u
       WHERE u.date <= ?1
       GROUP BY u.date, u.client, u.model, u.provider
       ORDER BY u.date`
    ).bind(today),
    env.DB.prepare(
      `SELECT u.date, sum(u.active_time_ms) AS active
       FROM daily_activity u WHERE u.date <= ?1 GROUP BY u.date ORDER BY u.date`
    ).bind(today),
    env.DB.prepare(
      `SELECT d.name, d.first_seen AS firstSeen, d.last_seen AS lastSeen,
              d.cli_version AS cliVersion, d.session_count AS sessions,
              d.total_active_time_ms AS activeMs,
              d.longest_continuous_ms AS longestMs,
              d.max_concurrent_sessions AS maxConcurrent,
              d.mcp_servers AS mcpServers,
              count(DISTINCT u.date) AS activeDays,
              sum(${TOKENS_SQL}) AS tokens,
              sum(u.messages) AS messages,
              sum(u.cost) AS cost
       FROM devices d LEFT JOIN daily_usage u
              ON u.device_id = d.id AND u.date <= ?1
       GROUP BY d.id ORDER BY d.last_seen DESC`
    ).bind(today),
  ]);

  const aggs = RANGES.map(
    ({ days }) => new RangeAgg(days ? shiftDays(today, 1 - days) : null)
  );
  const daily = new Map<string, SiteDay>();
  const dayFor = (date: string): SiteDay => {
    let day = daily.get(date);
    if (!day) {
      day = { date, tokens: 0, cost: 0, messages: 0, providers: emptySlices(), clients: emptySlices() };
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
    row.provider = canonicalProvider(row.provider, row.model);
    for (const agg of aggs) {
      // Only the lower bound is checked here: every range ends today,
      // and the query already stops there.
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
    schemaVersion: SITE_VERSION,
    generatedAt: new Date().toISOString(),
    today,
    ranges,
    daily: [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    devices,
  });
}

/** What rides along with the KV entry so the read path can validate it
 *  without parsing the body: the composition day (day-rollover guard),
 *  the schema version, and the body's ETag (conditional requests). */
interface SiteMeta {
  today?: string;
  version?: number;
  etag?: string;
}

/** Strong ETag — SHA-256 of the body, quoted per RFC 9110. Computed once
 *  at composition time so the read path never hashes anything. */
async function etagOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

function putSiteCache(env: Env, body: string, etag: string): Promise<void> {
  return env.SITE_CACHE.put(SITE_KEY, body, {
    metadata: { today: isoToday(), version: SITE_VERSION, etag } satisfies SiteMeta,
  });
}

/** Recompute the site payload and store it in KV. */
export async function refreshSiteCache(env: Env): Promise<void> {
  const body = await composeSiteBody(env);
  await putSiteCache(env, body, await etagOf(body));
}

export async function handleSite(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // One KV read per request, hot or cold (cacheTtl caps per-PoP
  // staleness after a submission rewrite). Recompose inline only when
  // the entry is missing or predates the etag metadata, was composed by
  // an older schema version, or was composed on a previous calendar day
  // and no device has reported since midnight (range windows must slide).
  const { value, metadata } = await env.SITE_CACHE.getWithMetadata<SiteMeta>(SITE_KEY, {
    cacheTtl: KV_CACHE_TTL,
  });
  let body = value;
  let etag = metadata?.etag;
  if (body === null || !etag || metadata?.version !== SITE_VERSION || metadata?.today !== isoToday()) {
    body = await composeSiteBody(env);
    etag = await etagOf(body);
    ctx.waitUntil(putSiteCache(env, body, etag));
  }

  // no-cache = store but always revalidate: browsers keep a copy yet
  // every load asks "still current?" — a ~0-byte 304 while the data is
  // unchanged, the fresh payload the moment a submission rewrote it.
  // Freshness is decided by the event-driven KV rewrite, never by a TTL.
  // The header set is constant across 200 and 304 (CORS included): any
  // variant-dependent header on a cacheable response is the poisoning
  // hazard documented in http.ts.
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    ETag: etag,
    ...CORS_HEADERS,
  };
  // Weak comparison (RFC 9110 §8.8.3.2): Cloudflare's edge compression
  // may hand the browser a W/-prefixed tag, which it echoes back here.
  const inm = request.headers.get("If-None-Match");
  if (inm && inm.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { headers });
}
