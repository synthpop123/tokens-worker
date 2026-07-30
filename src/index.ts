/**
 * tokens-usage — self-hosted backend for the `tokens` CLI (missuo/tokens).
 *
 * The write path implements the official server's submission contract and
 * merge semantics (per-device, per-day, per-client replace with regression
 * guard, parser-revision floors, authoritative clientManifest coverage).
 * The read path exposes the full usage matrix — (device, date, client,
 * model, provider) x (input, output, cacheRead, cacheWrite, reasoning,
 * messages, cost) — through filterable aggregation endpoints. The route
 * table below is the index; each handler module documents its own contract.
 *
 * Reads are public (it is just usage data) and open to any origin;
 * internal device ids are never exposed. Writes need the bearer token.
 *
 * Every accepted submission refreshes the precomposed /api/site payload in
 * KV and, once per Asia/Shanghai day, exports all tables to R2 — no cron
 * needed, submissions are the only write event and devices report every
 * 30 minutes.
 *
 * `/` serves the static homepage (public/index.html) through Workers Static
 * Assets, which matches before this router runs. Not implemented: the
 * browser GitHub OAuth device flow (POST /api/auth/device[/poll]); use
 * `tokens login --token` instead.
 */

import type { Env } from "./http";
import { json, CORS_HEADERS } from "./http";
import { handleSubmit, handleAuthToken, handleDeleteSubmittedData, handleMeStats } from "./submit";
import { handleSite } from "./site";
import {
  handleStats,
  handleTimeseries,
  handleBreakdown,
  handleGraph,
  handleMeta,
  handleDevices,
  handleSubmissions,
} from "./read";

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
  ["GET /api/me/stats", handleMeStats],
  // Public reads: the precomposed dashboard view (site.ts) and the
  // filterable aggregation endpoints (read.ts).
  ["GET /api/site", handleSite],
  ["GET /api/stats", handleStats],
  ["GET /api/timeseries", handleTimeseries],
  ["GET /api/breakdown", handleBreakdown],
  ["GET /api/graph", handleGraph],
  ["GET /api/meta", handleMeta],
  ["GET /api/devices", handleDevices],
  ["GET /api/submissions", handleSubmissions],
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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
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
  },
} satisfies ExportedHandler<Env>;
