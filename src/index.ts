/**
 * tokens-usage — self-hosted backend for the `tokens` CLI (missuo/tokens).
 *
 * The write path implements the official server's submission contract and
 * merge semantics (per-device, per-day, per-client replace with regression
 * guard, parser-revision floors, authoritative clientManifest coverage).
 * It stores the full usage matrix — (device, date, client, model,
 * provider) x (input, output, cacheRead, cacheWrite, reasoning, messages,
 * cost) — in D1. The route table below is the index; each handler module
 * documents its own contract.
 *
 * There is exactly one read endpoint, and that is the point: /api/site is
 * the view lkwplus.com/tokens consumes, and this backend has no second
 * consumer to generalize for. A filterable aggregation API once sat here
 * too (stats / timeseries / breakdown / graph / meta / devices /
 * submissions) — 677 lines answering questions nobody asked it, since
 * the CLI computes them locally and the dashboard reads the precomposed
 * payload. The matrix it queried is still in D1, still complete, and
 * still reachable by `wrangler d1 execute`, the R2 raw archives and the
 * daily exports; what went away is a public surface with no caller.
 *
 * Reads are public (it is just usage data) and open to any origin. Writes
 * need the bearer token. Internal device ids never leave the Worker.
 *
 * Every accepted submission refreshes the precomposed /api/site payload in
 * KV and, once per Asia/Shanghai day, exports the usage tables to R2 — no
 * cron needed, submissions are the only write event and devices report
 * every 30 minutes.
 *
 * The one write that is not a submission is POST /api/quota: the tokens
 * page also shows how much of the Codex subscription's weekly window is
 * spent, a number no session log contains. A collector reads it from the
 * vendor on the machine that holds the credential and reports it here,
 * so this Worker stores no vendor secret and runs no scheduled job for
 * it. It refreshes the same KV payload by the same event-driven rule.
 *
 * `/` serves the static homepage (public/index.html) through Workers Static
 * Assets, which matches before this router runs. Not implemented: the
 * browser GitHub OAuth device flow (POST /api/auth/device[/poll]); use
 * `tokens login --token` instead.
 */

import type { Env } from "./http";
import { json, CORS_HEADERS } from "./http";
import { handleSubmit, handleAuthToken, handleDeleteSubmittedData } from "./submit";
import { handleQuota } from "./quota";
import { handleSite, QUOTA_PROVIDERS } from "./site";

export type { Env };

type Handler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => Response | Promise<Response>;

/**
 * "METHOD /path" -> handler. One table, so a known path with the wrong
 * method answers 405 with the methods it does take instead of a misleading
 * 404. A Map, not an object: the key comes from the request, and a plain
 * object would resolve `constructor` off Object.prototype.
 */
const ROUTES = new Map<string, Handler>([
  // CLI-facing (bearer token; see submit.ts).
  ["POST /api/submit", handleSubmit],
  ["DELETE /api/settings/submitted-data", handleDeleteSubmittedData],
  ["GET /api/auth/token", handleAuthToken],
  // Reported by the quota collectors, not by the CLI itself (see
  // quota.ts). One route per subscription, derived from the provider
  // table so an unknown one 404s here rather than inside the handler.
  ...[...QUOTA_PROVIDERS.keys()].map(
    (id) => [`POST /api/quota/${id}`, handleQuota] as [string, Handler]
  ),
  // Public reads: the precomposed dashboard view, and a liveness check.
  ["GET /api/site", handleSite],
  ["GET /api/health", () => json({ service: "tokens-usage", ok: true }, 200, CORS_HEADERS)],
]);

/** Methods a known path accepts — drives the 405 and its Allow header. */
function allowedMethods(pathname: string): string[] {
  const allowed: string[] = [];
  for (const route of ROUTES.keys()) {
    const [method, path] = route.split(" ");
    if (path === pathname) allowed.push(method);
  }
  return allowed;
}

function route(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const { pathname } = new URL(request.url);
  const handler = ROUTES.get(`${request.method} ${pathname}`);
  if (handler) return handler(request, env, ctx);

  // Routing errors carry CORS for the same reason read errors do: a
  // browser must be able to read what went wrong.
  const allow = allowedMethods(pathname).join(", ");
  if (allow) {
    return json({ error: `Method not allowed, use ${allow}` }, 405, {
      Allow: allow,
      ...CORS_HEADERS,
    });
  }
  return json({ error: "Not found" }, 404, CORS_HEADERS);
}

export default {
  /**
   * Every response leaves through here, including the ones nobody
   * planned: an unhandled throw in a handler (D1 unreachable, KV
   * timeout) would otherwise become the runtime's own 500 — an HTML-ish
   * body with no CORS headers, which a cross-origin dashboard reads as a
   * CORS failure rather than as "the collector is down". That is exactly
   * the hazard the routing errors above already guard for 4xx, so the
   * 5xx path gets the same treatment: JSON body, full CORS, and the cause
   * logged to Workers Logs (observability is on in wrangler.jsonc).
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error("Unhandled error", request.method, new URL(request.url).pathname, error);
      return json({ error: "Internal error" }, 500, CORS_HEADERS);
    }
  },
} satisfies ExportedHandler<Env>;
