/**
 * Bindings and vars come from wrangler.jsonc via `wrangler types`
 * (Cloudflare.Env in the generated worker-configuration.d.ts), so the
 * binding list has exactly one source of truth. Secrets are not in that
 * file — they live on the Worker, and in the gitignored .dev.vars
 * locally — so they are declared here.
 */
export interface Env extends Cloudflare.Env {
  /** Bearer token for the write path. */
  TOKENS_API_TOKEN: string;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** All dates in the system are calendar days in this zone. */
export const TIME_ZONE = "Asia/Shanghai";

const isoDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today as YYYY-MM-DD in TIME_ZONE. */
export function isoToday(): string {
  return isoDayFormat.format(new Date());
}

/**
 * The read API is public and cookie-less, so CORS is a static wildcard —
 * never derived from the request's Origin. Reads are cacheable, and an
 * Origin-dependent header on a cacheable response poisons caches: this
 * Worker's homepage fetches /api/site same-origin (no Origin header) and
 * once cached a variant without CORS headers, which the browser then
 * reused for lkwplus.com/tokens' cross-origin read. A constant header set
 * keeps every response byte-identical for every requester.
 *
 * If-None-Match is allowed so scripts running their own conditional
 * requests can revalidate /api/site cross-origin: a browser's own HTTP
 * cache attaches the header without a preflight, but a hand-rolled fetch
 * preflights first and needs it advertised here. Write endpoints are
 * CLI-only (bearer token) and carry no CORS headers.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
};

export function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * Constant-time bearer token check: both sides are hashed to fixed-length
 * digests (so length never leaks) and compared with the runtime's
 * timing-safe primitive.
 */
export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match || !env.TOKENS_API_TOKEN) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(match[1])),
    crypto.subtle.digest("SHA-256", enc.encode(env.TOKENS_API_TOKEN)),
  ]);
  // Cloudflare-specific extension, absent from lib.dom's SubtleCrypto type.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
  };
  return subtle.timingSafeEqual(a, b);
}
