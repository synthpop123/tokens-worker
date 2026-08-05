/**
 * Integration tests over real (miniflare-backed) D1/KV/R2 bindings:
 * auth boundaries, the submit → merge → fan-out flow, full-wipe delete
 * semantics, the read API's query contract, and the privacy rule that
 * internal device ids never appear on public endpoints.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SITE_VERSION } from "../src/site";
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
  ])("%s rejects missing tokens", async (_name, request) => {
    const response = await request();
    expect(response.status).toBe(401);
  });

  it("rejects wrong tokens", async () => {
    const response = await call("/api/auth/token", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  // /api/me/stats was the one endpoint that ever returned internal device
  // ids. Its consumer (the CLI's TUI remote tab) went away in v27, so the
  // endpoint went too — and with it the whole category of leak.
  it("no longer exposes the device-id endpoint at all", async () => {
    await submit();
    const response = await call("/api/me/stats", { headers: AUTH });
    expect(response.status).toBe(404);
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
    expect(site.metadata?.version).toBe(SITE_VERSION);
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

  // The audit log grows with report cadence, not with data — ~80 rows a
  // day, most of them no-ops — so every submission trims its own tail.
  it("keeps the audit log to a rolling window", async () => {
    await submit();
    const ancient = Date.now() - 400 * 86_400_000;
    await env.DB.prepare(
      `INSERT INTO submissions
         (id, device_id, received_at, date_start, date_end, total_tokens,
          total_cost, row_count, changed_days, mode)
       VALUES ('ancient', ?, ?, '2025-01-01', '2025-01-01', 0, 0, 0, 0, 'merge')`
    )
      .bind(DEVICE_ID, ancient)
      .run();
    expect(
      (await env.DB.prepare(`SELECT count(*) AS n FROM submissions`).first<{ n: number }>())?.n
    ).toBe(2);

    await submit();

    const remaining = await env.DB.prepare(`SELECT id FROM submissions`).all<{ id: string }>();
    expect(remaining.results.map((row) => row.id)).not.toContain("ancient");
  });

  // The daily export exists to restore usage data. The audit log is not
  // that, and copying an append-only log into a fresh object every day is
  // how storage grows quadratically.
  it("excludes the audit log from the daily R2 export", async () => {
    await submit();
    const backups = await env.ARCHIVE.list({ prefix: "backup/" });
    const dump = JSON.parse(await (await env.ARCHIVE.get(backups.objects[0].key))!.text());
    expect(Object.keys(dump).sort()).toEqual([
      "daily_activity",
      "daily_usage",
      "devices",
      "exportedAt",
      "schema",
    ]);
    expect(dump.daily_usage).toHaveLength(2);
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

    // Read endpoints too — a known path never answers a misleading 404.
    const read = await call("/api/site", { method: "POST" });
    expect(read.status).toBe(405);
    expect(read.headers.get("Allow")).toBe("GET");

    expect((await call("/api/nope")).status).toBe(404);
  });
});

describe("unhandled failures", () => {
  // A handler that throws (D1 unreachable, KV timeout) would otherwise
  // reach the client as the runtime's own 500: no JSON, no CORS, so a
  // cross-origin dashboard reads "CORS failure" instead of "collector is
  // down". Renaming the table away is the cheapest real D1 error.
  it("answers a thrown handler with JSON and CORS, not a bare 500", async () => {
    await env.DB.prepare(`ALTER TABLE daily_usage RENAME TO daily_usage_hidden`).run();
    try {
      const response = await call("/api/stats");
      expect(response.status).toBe(500);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await response.json()).toEqual({ error: "Internal error" });
    } finally {
      await env.DB.prepare(`ALTER TABLE daily_usage_hidden RENAME TO daily_usage`).run();
    }
  });
});

describe("GET /api/health", () => {
  it("is a browser-readable liveness check", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
    // Public reads are open to any origin; the health check is no exception.
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({ service: "tokens-usage", ok: true });
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

  it("re-attributes gateway provider rows to model vendors on aggregates", async () => {
    // Day 2 rewritten as gateway-provider rows: a Zed-hosted Claude model,
    // GLM through OpenCode zen, and DeepSeek through pi's OpenCode Go.
    const payload = submissionPayload();
    payload.summary!.totalTokens = 1600;
    payload.summary!.totalCost = 0.55;
    payload.summary!.clients = ["cursor", "zed", "opencode", "pi"];
    payload.contributions![1].totals = { tokens: 600, cost: 0.35, messages: 5 };
    payload.contributions![1].clients = [
      {
        client: "zed",
        modelId: "claude-sonnet-5",
        providerId: "zed.dev",
        tokens: { input: 100, output: 100, cacheRead: 50, cacheWrite: 30, reasoning: 20 },
        cost: 0.2,
        messages: 3,
        provenance: { schemaVersion: 3, messageCount: 3, modelCount: 1 },
      },
      {
        client: "opencode",
        modelId: "glm-4.7",
        providerId: "opencode",
        tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 10, reasoning: 10 },
        cost: 0.1,
        messages: 1,
        provenance: { schemaVersion: 3, messageCount: 1, modelCount: 1 },
      },
      {
        client: "pi",
        modelId: "deepseek-v4-flash",
        providerId: "opencode-go",
        tokens: { input: 50, output: 25, cacheRead: 10, cacheWrite: 10, reasoning: 5 },
        cost: 0.05,
        messages: 1,
        provenance: { schemaVersion: 3, messageCount: 1, modelCount: 1 },
      },
    ];
    await submit(payload);

    // /api/stats: byProvider re-attributed (no gateway ids), byModel
    // providers lists re-attributed too.
    const stats = (await (await call("/api/stats")).json()) as Record<string, any>;
    expect(stats.byProvider).toEqual([
      expect.objectContaining({ provider: "anthropic", tokens: 1300 }),
      expect.objectContaining({ provider: "zai", tokens: 200 }),
      expect.objectContaining({ provider: "deepseek", tokens: 100 }),
    ]);
    expect(stats.byModel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "glm-4.7", providers: "zai" }),
        expect.objectContaining({ model: "deepseek-v4-flash", providers: "deepseek" }),
        expect.objectContaining({ model: "claude-sonnet-5", providers: "anthropic" }),
      ])
    );

    // Timeseries and breakdown agree.
    const series = (await (
      await call("/api/timeseries?interval=month&group=provider")
    ).json()) as Record<string, any>;
    expect(series.series).toEqual([
      expect.objectContaining({ period: "2026-07", key: "anthropic", tokens: 1300 }),
      expect.objectContaining({ period: "2026-07", key: "zai", tokens: 200 }),
      expect.objectContaining({ period: "2026-07", key: "deepseek", tokens: 100 }),
    ]);
    const breakdown = (await (
      await call("/api/breakdown?by=provider")
    ).json()) as Record<string, any>;
    expect(breakdown.rows).toEqual([
      expect.objectContaining({ provider: "anthropic", tokens: 1300 }),
      expect.objectContaining({ provider: "zai", tokens: 200 }),
      expect.objectContaining({ provider: "deepseek", tokens: 100 }),
    ]);
    expect(breakdown.rows[0]).not.toHaveProperty("model");

    // /api/site: provider breakdown and daily slices agree.
    const site = (await (await call("/api/site")).json()) as Record<string, any>;
    expect(site.ranges.all.byProvider).toEqual([
      expect.objectContaining({ provider: "anthropic", tokens: 1300 }),
      expect.objectContaining({ provider: "zai", tokens: 200 }),
      expect.objectContaining({ provider: "deepseek", tokens: 100 }),
    ]);
    expect(site.daily[1].providers).toEqual({
      anthropic: expect.objectContaining({ tokens: 300 }),
      zai: expect.objectContaining({ tokens: 200 }),
      deepseek: expect.objectContaining({ tokens: 100 }),
    });

    // Raw ids stay the filter vocabulary: /api/meta lists the gateway
    // spellings, and provider= matches them.
    const meta = (await (await call("/api/meta")).json()) as Record<string, any>;
    expect(meta.providers).toEqual(["anthropic", "opencode", "opencode-go", "zed.dev"]);
    const filtered = (await (
      await call("/api/stats?provider=zed.dev")
    ).json()) as Record<string, any>;
    expect(filtered.totals.tokens).toBe(300);
    expect(filtered.byProvider).toEqual([
      expect.objectContaining({ provider: "anthropic", tokens: 300 }),
    ]);
    const goFiltered = (await (
      await call("/api/stats?provider=opencode-go")
    ).json()) as Record<string, any>;
    expect(goFiltered.totals.tokens).toBe(100);
    expect(goFiltered.byProvider).toEqual([
      expect.objectContaining({ provider: "deepseek", tokens: 100 }),
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

  it("reads an empty parameter value as an absent one", async () => {
    // One rule for every parameter: ?group= is not a group named "", and
    // ?limit= is not a limit of zero.
    await submit();
    for (const path of [
      "/api/timeseries?group=",
      "/api/timeseries?interval=",
      "/api/graph?year=",
      "/api/stats?from=&client=",
      "/api/submissions?limit=",
      "/api/breakdown?limit=",
    ]) {
      expect((await call(path)).status, path).toBe(200);
    }
    const series = (await (await call("/api/timeseries?group=")).json()) as Record<string, any>;
    expect(series.group).toBeNull();
  });

  it("does not resolve enum values off Object.prototype", async () => {
    // Every lookup table keyed by a query value is a Map: as plain objects,
    // `?interval=constructor` used to pass the `unknown value` guard and
    // interpolate a function into the SQL (a 500 instead of a 400).
    for (const path of [
      "/api/timeseries?interval=constructor",
      "/api/timeseries?group=toString",
      "/api/breakdown?by=constructor",
      "/api/breakdown?by=model,hasOwnProperty",
    ]) {
      expect((await call(path)).status, path).toBe(400);
    }
  });

  it("rejects an out-of-range limit instead of silently clamping", async () => {
    for (const path of [
      "/api/submissions?limit=abc",
      "/api/submissions?limit=0",
      "/api/submissions?limit=501",
      "/api/breakdown?limit=1.5",
      "/api/breakdown?limit=-1",
    ]) {
      const response = await call(path);
      expect(response.status, path).toBe(400);
      expect(((await response.json()) as { error: string }).error, path).toContain("limit must be");
    }
    expect((await call("/api/submissions?limit=500")).status).toBe(200);
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
