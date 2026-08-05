/**
 * The metric set — the eight numbers every usage row carries — in the
 * three forms the Worker needs it: a TypeScript shape, the SQL that
 * projects it out of the usage matrix, and the helpers that fold rows
 * into it. Declaring it once is what keeps the write path's response
 * metrics and `/api/site` reporting the same numbers under the same
 * names.
 *
 * Every query that interpolates these fragments aliases `daily_usage`
 * as `u`.
 */

export interface Metrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** Sum of the five categories above. */
  tokens: number;
  messages: number;
  cost: number;
}

export const METRIC_KEYS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "tokens",
  "messages",
  "cost",
] as const satisfies readonly (keyof Metrics)[];

/** The five token categories summed — "tokens" everywhere in the API. */
export const TOKENS_SQL = "u.input + u.output + u.cache_read + u.cache_write + u.reasoning";

/** The full metric set, aliased to the camelCase names the API serves. */
export const METRICS_SQL = `
  sum(u.input) AS input,
  sum(u.output) AS output,
  sum(u.cache_read) AS cacheRead,
  sum(u.cache_write) AS cacheWrite,
  sum(u.reasoning) AS reasoning,
  sum(${TOKENS_SQL}) AS tokens,
  sum(u.messages) AS messages,
  sum(u.cost) AS cost`;

/**
 * A day is active when it saw any activity. Early-2025 Cursor logs carry
 * message counts without token usage; those days count too (the CLI's own
 * summary.activeDays agrees).
 */
export const ACTIVE_DAYS_SQL = `count(DISTINCT CASE
  WHEN ${TOKENS_SQL} > 0 OR u.messages > 0 THEN u.date END) AS activeDays`;

export function emptyMetrics(): Metrics {
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

export function addMetrics(target: Metrics, row: Metrics): void {
  for (const key of METRIC_KEYS) target[key] += row[key];
}

/** Ranks anything that counts tokens — full metric rows and the leaner
 *  per-client model cells alike. */
export const byTokensDesc = (a: { tokens: number }, b: { tokens: number }): number =>
  b.tokens - a.tokens;
