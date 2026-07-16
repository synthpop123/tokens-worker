export interface Env {
  DB: D1Database;
  TOKENS_API_TOKEN: string;
  TOKENS_USERNAME?: string;
}

const ALLOWED_ORIGINS = ["https://lkwplus.com"];

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin !== null &&
    (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin));
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

/** Constant-time bearer token check (compares SHA-256 digests). */
export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
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
