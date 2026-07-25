/**
 * Integration tests over real (miniflare-backed) D1/KV/R2 bindings:
 * auth boundaries, the submit → merge → fan-out flow, full-wipe delete
 * semantics, the read API's query contract, and the privacy rule that
 * internal device ids never appear on public endpoints.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH, call, DEVICE_ID, reset, submissionPayload, submit } from "./helpers";

beforeEach(() => reset());

describe("auth boundaries", () => {
  it.each([
    ["POST /api/submit", () => call("/api/submit", { method: "POST", body: "{}" })],
    [
      "DELETE /api/settings/submitted-data",
      () => call("/api/settings/submitted-data", { method: "DELETE" }),
    ],
    ["GET /api/auth/token", () => call("/api/auth/token")],
    ["GET /api/me/stats", () => call("/api/me/stats")],
  ])("%s rejects missing tokens", async (_name, request) => {
    const response = await request();
    expect(response.status).toBe(401);
  });

  it("rejects wrong tokens", async () => {
    const response = await call("/api/me/stats", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  it("validates the token for tokens login", async () => {
    const response = await call("/api/auth/token", { headers: AUTH });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { username: "lkw123", avatarUrl: null },
    });
  });
});

describe("submit flow", () => {
  it("creates, archives and fans out on first upload", async () => {
    const response = await submit();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.mode).toBe("create");
    expect(body.warnings).toBeUndefined();
    expect(body.metrics).toMatchObject({
      totalTokens: 1500,
      activeDays: 2,
      dateRange: { start: "2026-07-18", end: "2026-07-19" },
      clients: ["claude", "cursor"],
    });
    expect(body.metrics.totalCost).toBeCloseTo(0.5);

    // D1: the usage matrix, activity and audit row landed atomically.
    const rows = await env.DB.prepare(
      `SELECT date, client, model, provider, input, cost, parser_revision
       FROM daily_usage ORDER BY date`
    ).all();
    expect(rows.results).toEqual([
      expect.objectContaining({
        date: "2026-07-18", client: "cursor", model: "claude-opus-4-5",
        provider: "anthropic", input: 400, parser_revision: 3,
      }),
      expect.objectContaining({ date: "2026-07-19", client: "claude", input: 200 }),
    ]);
    expect((rows.results[0] as { cost: number }).cost).toBeCloseTo(0.2);
    const activity = await env.DB.prepare(`SELECT date, active_time_ms FROM daily_activity`).all();
    expect(activity.results).toEqual([{ date: "2026-07-18", active_time_ms: 3_600_000 }]);

    // R2: raw payload archived, daily backup exported.
    expect(await env.ARCHIVE.head(`raw/${DEVICE_ID}/latest.json`)).not.toBeNull();
    const backups = await env.ARCHIVE.list({ prefix: "backup/" });
    expect(backups.objects).toHaveLength(1);

    // KV: the site payload was recomposed by this submission.
    const site = await env.SITE_CACHE.getWithMetadata<{ version?: number }>("site");
    expect(site.value).not.toBeNull();
    expect(site.metadata?.version).toBe(4);
  });

  it("is idempotent: an identical resubmit merges without rewriting", async () => {
    await submit();
    const response = await submit();
    const body = (await response.json()) as Record<string, any>;
    expect(body.mode).toBe("merge");
    expect(body.warnings).toBeUndefined();
    expect(body.metrics.totalTokens).toBe(1500);
    const audit = await env.DB.prepare(
      `SELECT row_count, changed_days FROM submissions ORDER BY received_at DESC, rowid DESC LIMIT 1`
    ).first<{ row_count: number; changed_days: number }>();
    expect(audit).toEqual({ row_count: 0, changed_days: 0 });
  });

  it("preserves stored history against a same-revision token regression", async () => {
    await submit();
    const reduced = submissionPayload();
    const day = reduced.contributions![0];
    day.clients[0].tokens = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    day.clients[0].cost = 0.05;
    day.totals = { tokens: 100, cost: 0.05, messages: 6 };
    reduced.summary!.totalTokens = 600;
    reduced.summary!.totalCost = 0.35;
    const response = await submit(reduced);
    const body = (await response.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.warnings?.some((w: string) => w.includes("would reduce"))).toBe(true);
    expect(body.metrics.totalTokens).toBe(1500);
  });

  it("rejects malformed and inconsistent payloads", async () => {
    const notJson = await call("/api/submit", { method: "POST", headers: AUTH, body: "{" });
    expect(notJson.status).toBe(400);

    const empty = await call("/api/submit", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ contributions: [] }),
    });
    expect(empty.status).toBe(400);

    const inconsistent = submissionPayload();
    inconsistent.summary!.totalTokens = 999_999;
    const mismatch = await submit(inconsistent);
    expect(mismatch.status).toBe(400);
    const body = (await mismatch.json()) as Record<string, any>;
    expect(body.error).toBe("Validation failed");
    expect(body.details.some((d: string) => d.includes("Token total mismatch"))).toBe(true);
  });

  it("answers wrong methods with a 405 naming the expected one", async () => {
    const response = await call("/api/submit");
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});

describe("GET /api/me/stats", () => {
  it("serves the schemaVersion-1 wire contract to authenticated CLIs", async () => {
    await submit();
    const response = await call("/api/me/stats", { headers: AUTH });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.schemaVersion).toBe(1);
    expect(body.totalTokens).toBe(1500);
    expect(body.deviceCount).toBe(1);
    expect(body.days).toHaveLength(2);
    expect(body.days[0]).toMatchObject({ date: "2026-07-18", tokens: 1000, inputTokens: 400 });
    // Internal device ids are allowed here — the endpoint is authenticated.
    expect(body.devices[0]).toMatchObject({ id: DEVICE_ID, displayName: "Test MacBook" });
  });
});

describe("DELETE /api/settings/submitted-data", () => {
  it("wipes D1, R2 and the KV site payload before responding", async () => {
    await submit();
    const response = await call("/api/settings/submitted-data", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, deletedSubmissions: 1 });

    for (const table of ["daily_usage", "daily_activity", "devices", "submissions"]) {
      const count = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(count?.n).toBe(0);
    }
    const objects = await env.ARCHIVE.list();
    expect(objects.objects).toEqual([]);

    // The KV payload was recomposed synchronously: the dashboard sees
    // zeroed data immediately, not the pre-delete snapshot.
    const site = JSON.parse((await env.SITE_CACHE.get("site")) ?? "null");
    expect(site?.daily).toEqual([]);
    expect(site?.devices).toEqual([]);
  });

  it("is idempotent", async () => {
    const response = await call("/api/settings/submitted-data", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(await response.json()).toEqual({ deleted: false, deletedSubmissions: 0 });
  });
});

describe("read API query contract", () => {
  it("serves filtered aggregates", async () => {
    await submit();
    const response = await call("/api/stats?client=cursor&from=2026-07-01");
    const body = (await response.json()) as Record<string, any>;
    expect(body.totals.tokens).toBe(1000);
    expect(body.byClient).toHaveLength(1);

    // Canonical merging: both spellings collapse into claude-opus-4-5.
    const all = (await (await call("/api/stats")).json()) as Record<string, any>;
    expect(all.byModel).toHaveLength(1);
    expect(all.byModel[0]).toMatchObject({ model: "claude-opus-4-5", tokens: 1500 });

    const series = (await (
      await call("/api/timeseries?interval=month&group=model")
    ).json()) as Record<string, any>;
    expect(series.series).toEqual([
      expect.objectContaining({ period: "2026-07", key: "claude-opus-4-5", tokens: 1500 }),
    ]);
  });

  it("rejects parameters an endpoint would otherwise silently ignore", async () => {
    for (const path of [
      "/api/stats?foo=1",
      "/api/meta?client=cursor",
      "/api/devices?from=2026-01-01",
      "/api/submissions?client=cursor",
      "/api/graph?interval=day",
      "/api/timeseries?by=model",
    ]) {
      const response = await call(path);
      expect(response.status, path).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error, path).toContain("Unsupported parameter");
    }
  });

  it("caps comma-list filter values below D1's bound-parameter limit", async () => {
    const list = Array.from({ length: 21 }, (_, i) => `c${i}`).join(",");
    const response = await call(`/api/stats?client=${list}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("at most 20");
  });

  it("keeps validating filter shapes", async () => {
    expect((await call("/api/stats?from=2026/01/01")).status).toBe(400);
    expect((await call("/api/timeseries?interval=hour")).status).toBe(400);
    expect((await call("/api/breakdown?by=nope")).status).toBe(400);
    expect((await call("/api/graph?year=26")).status).toBe(400);
  });

  it("never exposes internal device ids on public endpoints", async () => {
    await submit();
    const byName = ["/api/stats", "/api/devices", "/api/meta", "/api/submissions", "/api/site"];
    for (const path of [...byName, "/api/graph"]) {
      const text = await (await call(path)).text();
      expect(text, path).not.toContain(DEVICE_ID);
      if (byName.includes(path)) expect(text, path).toContain("Test MacBook");
    }
  });

  it("reconstructs the tokens-graph export shape", async () => {
    await submit();
    const body = (await (await call("/api/graph")).json()) as Record<string, any>;
    expect(body.summary).toMatchObject({ totalTokens: 1500, activeDays: 2 });
    expect(body.contributions).toHaveLength(2);
    expect(body.contributions[0]).toMatchObject({
      date: "2026-07-18",
      intensity: 3,
      activeTimeMs: 3_600_000,
    });
    // Full-fidelity export keeps raw model spellings.
    expect(body.contributions[1].clients[0].modelId).toBe("claude-opus-4-5-thinking");
  });
});
