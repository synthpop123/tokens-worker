/**
 * tokens-usage — self-hosted backend for the `tokens` CLI (missuo/tokens).
 *
 * Write path implements the official server's submission contract and merge
 * semantics (per-device, per-day, per-client replace with regression guard,
 * parser-revision floors, and authoritative clientManifest coverage). Read
 * path exposes the full usage matrix — (device, date, client, model,
 * provider) x (input, output, cacheRead, cacheWrite, reasoning, messages,
 * cost) — through filterable aggregation endpoints.
 *
 * CLI-facing:
 *   POST   /api/submit                  tokens submit / serve / autosubmit (auth)
 *   DELETE /api/settings/submitted-data tokens delete-submitted-data (auth)
 *   GET    /api/auth/token              tokens login --token (auth)
 *   GET    /api/me/stats                TUI remote tab
 *
 * Read side — public, it is just usage data (open CORS, 5-minute cache;
 * internal device ids are never exposed):
 *   GET /api/site — precomposed dashboard view for lkwplus.com/tokens,
 *       served straight from KV (refreshed by the cron below)
 *   GET /api/stats, /api/timeseries, /api/breakdown, /api/graph,
 *       /api/meta, /api/devices, /api/submissions, /api/health
 *
 * Every accepted submission refreshes the precomposed /api/site payload
 * in KV and, once per Asia/Shanghai day, exports all tables to R2
 * (backup/YYYY-MM-DD.json) — no cron needed, submissions are the only
 * write event and devices report every 30 minutes.
 *
 * The homepage (architecture + API reference) is a static asset:
 * public/index.html, served by Workers Static Assets before this router
 * runs — "/" never reaches the Worker.
 *
 * Not implemented: the browser-based GitHub OAuth device flow
 * (POST /api/auth/device[/poll]); use `tokens login --token` instead.
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

/** Endpoints that only accept one non-GET method, for 405 responses. */
const METHOD_FOR: Record<string, string> = {
  "/api/submit": "POST",
  "/api/settings/submitted-data": "DELETE",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (method === "POST" && pathname === "/api/submit") {
      return handleSubmit(request, env, ctx);
    }
    if (method === "DELETE" && pathname === "/api/settings/submitted-data") {
      return handleDeleteSubmittedData(request, env, ctx);
    }

    if (method === "GET") {
      switch (pathname) {
        case "/api/site":
          return handleSite(request, env, ctx);
        case "/api/stats":
          return handleStats(request, env);
        case "/api/timeseries":
          return handleTimeseries(request, env);
        case "/api/breakdown":
          return handleBreakdown(request, env);
        case "/api/graph":
          return handleGraph(request, env);
        case "/api/meta":
          return handleMeta(request, env);
        case "/api/devices":
          return handleDevices(request, env);
        case "/api/submissions":
          return handleSubmissions(request, env);
        case "/api/me/stats":
          return handleMeStats(request, env);
        case "/api/auth/token":
          return handleAuthToken(request, env);
        case "/":
        case "/api/health":
          return json({ service: "tokens-usage", ok: true });
      }
    }

    // Known path, wrong method: say which method it wants.
    const expected = METHOD_FOR[pathname];
    if (expected && method !== expected) {
      return json({ error: `Method not allowed, use ${expected}` }, 405, { Allow: expected });
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
