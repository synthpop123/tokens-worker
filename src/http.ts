export interface Env {
  DB: D1Database;
  /** Precomposed /api/site payload, refreshed by the 5-minute cron. */
  SITE_CACHE: KVNamespace;
  /** Raw submission payloads + daily D1 exports (see backup.ts). */
  ARCHIVE: R2Bucket;
  TOKENS_API_TOKEN: string;
  TOKENS_USERNAME?: string;
}

const ALLOWED_ORIGINS = [
  "https://lkwplus.com",
  "https://likangwei.vercel.app",
  "https://lkw123.vercel.app",
  "https://lkw.vercel.app",
];

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
 * Browsers only ever GET the public read API; the write endpoints are
 * CLI-only and exempt from CORS, so the preflight surface stays minimal.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin !== null &&
    (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin));
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

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
