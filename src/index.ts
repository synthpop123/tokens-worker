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
 * Read side — public, it is just usage data (CORS for lkwplus.com,
 * 5-minute cache):
 *   GET /api/stats, /api/timeseries, /api/breakdown, /api/graph,
 *       /api/meta, /api/devices, /api/submissions, /api/health
 *
 * Not implemented: the browser-based GitHub OAuth device flow
 * (POST /api/auth/device[/poll]); use `tokens login --token` instead.
 */

import type { Env } from "./http";
import { json, corsHeaders } from "./http";
import { handleSubmit, handleAuthToken, handleDeleteSubmittedData, handleMeStats } from "./submit";
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get("Origin")),
      });
    }

    if (method === "POST" && pathname === "/api/submit") return handleSubmit(request, env);
    if (method === "DELETE" && pathname === "/api/settings/submitted-data") {
      return handleDeleteSubmittedData(request, env);
    }

    if (method === "GET") {
      switch (pathname) {
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

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
