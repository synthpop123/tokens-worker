export interface Env {
  DB: D1Database;
  /** Precomposed /api/site payload (+ its ETag in metadata), rewritten
   *  by every accepted submission. */
  SITE_CACHE: KVNamespace;
  /** Raw submission payloads + daily D1 exports (see backup.ts). */
  ARCHIVE: R2Bucket;
  TOKENS_API_TOKEN: string;
  TOKENS_USERNAME?: string;
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
 * The read API is public and cookie-less, so CORS is a static wildcard.
 * Reads are cacheable, and an Origin-dependent header on a cacheable
 * response is a cache-poisoning hazard: the Worker homepage's same-origin
 * fetch of /api/site (no Origin header) used to cache a variant without
 * CORS headers, which the browser then reused for lkwplus.com/tokens'
 * cross-origin read — failing its CORS check. A constant header set keeps
 * every response byte-identical for every requester, so no cache tier can
 * serve the wrong variant. Write endpoints are CLI-only (bearer token)
 * and never carry CORS headers.
 *
 * If-None-Match is allowed so scripts that manage their own conditional
 * requests can revalidate /api/site cross-origin (browser HTTP caches
 * attach it without a preflight; hand-rolled ones preflight first).
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
