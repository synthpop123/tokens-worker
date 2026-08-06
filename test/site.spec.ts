/**
 * Producer-side contract for GET /api/site — the cross-repo boundary the
 * homepage (lkwplus.com/tokens) consumes. The structural assertions here
 * mirror the consumer's `isSite` decoder (homepage:
 * src/lib/client/tokens.ts) field by field; if a shape change breaks one
 * side, this is the test that says so before a deploy does. Bump
 * SITE_VERSION and the homepage's SITE_SCHEMA_VERSION together, and
 * refresh the homepage's committed fixture.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { isoToday } from "../src/http";
import { SITE_VERSION } from "../src/site";
import {
  call,
  reportClaudeQuota,
  reportQuota,
  reset,
  submissionPayload,
  submit,
} from "./helpers";

beforeEach(() => reset());

const RANGE_KEYS = ["day", "week", "month", "quarter", "all"] as const;
const METRIC_KEYS = [
  "input", "output", "cacheRead", "cacheWrite", "reasoning", "tokens", "messages", "cost",
] as const;
const SPAN_KEYS = ["days", "firstDate", "lastDate"] as const;

/** The exact spine the homepage reads unconditionally. */
function expectSiteContract(site: Record<string, any>): void {
  expect(site.schemaVersion).toBe(SITE_VERSION);
  expect(typeof site.generatedAt).toBe("string");
  expect(site.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  for (const key of RANGE_KEYS) {
    const range = site.ranges[key];
    expect(range, `ranges.${key}`).toBeDefined();
    for (const metric of [...METRIC_KEYS, "activeDays"]) {
      expect(typeof range.totals[metric], `ranges.${key}.totals.${metric}`).toBe("number");
    }
    for (const [list, id] of [
      ["byModel", "model"],
      ["byClient", "client"],
      ["byProvider", "provider"],
    ] as const) {
      expect(Array.isArray(range[list]), `ranges.${key}.${list}`).toBe(true);
      for (const row of range[list]) {
        expect(typeof row[id]).toBe("string");
        for (const metric of METRIC_KEYS) expect(typeof row[metric]).toBe("number");
        for (const span of SPAN_KEYS) expect(row).toHaveProperty(span);
      }
    }

    // Model rows name the providers that served them; client and
    // provider rows carry the cell-level split their marginals cannot
    // reconstruct.
    for (const row of range.byModel) {
      expect(Array.isArray(row.providers), `ranges.${key}.byModel.providers`).toBe(true);
      for (const provider of row.providers) expect(typeof provider).toBe("string");
    }
    for (const [list, id] of [
      ["byClient", "client"],
      ["byProvider", "provider"],
    ] as const) {
      for (const row of range[list]) {
        expect(Array.isArray(row.models), `ranges.${key}.${list}.models`).toBe(true);
        for (const cell of row.models) {
          expect(typeof cell.model).toBe("string");
          for (const metric of ["tokens", "cost", "messages"]) {
            expect(typeof cell[metric], `ranges.${key}.${list}.models.${metric}`).toBe("number");
          }
        }
        // The cells are a partition of the row itself, not a sample.
        const summed = row.models.reduce((sum: number, cell: any) => sum + cell.tokens, 0);
        expect(summed, `ranges.${key}.${list}[${row[id]}].models sum`).toBe(row.tokens);
      }
    }
  }

  // The one reported list: empty until a collector has spoken, and one
  // dated plan per subscription after (the endpoint's own spec covers
  // the narrowing). Each plan dates itself — two collectors on their own
  // timers are two different answers to "how old is this".
  expect(Array.isArray(site.quota), "quota").toBe(true);
  for (const plan of site.quota) {
    expect(typeof plan.provider).toBe("string");
    expect(typeof plan.label).toBe("string");
    expect(plan.plan === null || typeof plan.plan === "string", "quota.plan").toBe(true);
    expect(Number.isFinite(Date.parse(plan.capturedAt)), "quota.capturedAt").toBe(true);
    expect(Array.isArray(plan.windows) && plan.windows.length > 0, "quota.windows").toBe(true);
    for (const window of plan.windows) {
      expect(typeof window.label).toBe("string");
      expect(typeof window.usedPercent).toBe("number");
      expect(
        window.resetsAt === null || typeof window.resetsAt === "string",
        "quota.windows.resetsAt"
      ).toBe(true);
    }
    expect(
      Array.isArray(plan.resetCredits) &&
        plan.resetCredits.every((at: unknown) => typeof at === "string"),
      "quota.resetCredits"
    ).toBe(true);
  }

  expect(Array.isArray(site.daily)).toBe(true);
  for (const day of site.daily) {
    expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const metric of ["tokens", "cost", "messages"]) {
      expect(typeof day[metric], `daily.${metric}`).toBe("number");
    }
    // The three stacking dimensions the trend chart Object.entries() over.
    for (const dim of ["providers", "clients", "models"]) {
      expect(day[dim], `daily.${dim}`).toBeTypeOf("object");
      for (const slice of Object.values(day[dim]) as Array<Record<string, unknown>>) {
        expect(typeof slice.tokens).toBe("number");
        expect(typeof slice.cost).toBe("number");
      }
    }
  }

  expect(Array.isArray(site.devices)).toBe(true);
  for (const device of site.devices) {
    expect(typeof device.name).toBe("string");
    expect(device).not.toHaveProperty("id");
    for (const metric of ["activeDays", "tokens", "messages", "cost"]) {
      expect(typeof device[metric], `devices.${metric}`).toBe("number");
    }
    // Nullable metadata must be null or the right type, never undefined
    // or a lookalike (the consumer's isDevice rejects e.g. a string
    // mcpServers, whose truthy .length would reach .join() otherwise).
    for (const field of ["firstSeen", "lastSeen", "sessions", "activeMs", "longestMs", "maxConcurrent"]) {
      expect(
        device[field] === null || typeof device[field] === "number",
        `devices.${field}`
      ).toBe(true);
    }
    expect(
      device.cliVersion === null || typeof device.cliVersion === "string",
      "devices.cliVersion"
    ).toBe(true);
    expect(
      device.mcpServers === null ||
        (Array.isArray(device.mcpServers) &&
          device.mcpServers.every((s: unknown) => typeof s === "string")),
      "devices.mcpServers"
    ).toBe(true);
  }
}

describe("GET /api/site", () => {
  // The contract above accepts an empty quota list, which is what every
  // other test in this file produces — so one case has to populate it,
  // or a reported plan's shape would go unpinned on this side.
  it("holds the same contract with both quota plans reported", async () => {
    await submit();
    await reportQuota();
    await reportClaudeQuota();
    const site = (await (await call("/api/site")).json()) as Record<string, any>;
    expectSiteContract(site);
    expect(site.quota).toHaveLength(2);
  });

  it("serves the versioned dashboard contract after a submission", async () => {
    await submit();
    const response = await call("/api/site");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const etag = response.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const site = (await response.json()) as Record<string, any>;
    expectSiteContract(site);

    // Canonicalization happened before aggregation: one merged model row,
    // provider slices keyed by canonical ids.
    expect(site.ranges.all.byModel).toEqual([
      expect.objectContaining({
        model: "claude-opus-4-5",
        tokens: 1500,
        days: 2,
        providers: ["anthropic"],
      }),
    ]);

    // The client → model join, on the exact case that makes it worth
    // carrying: one canonical model reached through two clients, which
    // byModel (1500 under one model) and byClient (1000 + 500) can each
    // only half describe.
    expect(site.ranges.all.byClient).toEqual([
      expect.objectContaining({
        client: "cursor",
        tokens: 1000,
        models: [{ model: "claude-opus-4-5", tokens: 1000, cost: 0.2, messages: 6 }],
      }),
      expect.objectContaining({
        client: "claude",
        tokens: 500,
        models: [{ model: "claude-opus-4-5", tokens: 500, cost: 0.3, messages: 4 }],
      }),
    ]);
    expect(site.daily).toHaveLength(2);
    expect(site.daily[0]).toMatchObject({
      date: "2026-07-18",
      tokens: 1000,
      active: 3_600_000,
      providers: { anthropic: expect.objectContaining({ tokens: 1000 }) },
      clients: { cursor: expect.objectContaining({ tokens: 1000 }) },
      // Keyed canonically, so a day's model slices agree with byModel
      // rather than splitting one model across its effort spellings.
      models: { "claude-opus-4-5": expect.objectContaining({ tokens: 1000 }) },
    });
    expect(site.devices).toEqual([
      expect.objectContaining({
        name: "Test MacBook",
        cliVersion: "3.2.1",
        sessions: 5,
        mcpServers: ["context7"],
      }),
    ]);
  });

  it("scopes the day range to today, models included", async () => {
    // The dashboard's Today section is the only consumer of a per-model
    // split of a single calendar day — the daily series carries client and
    // provider slices but no models — so the window has to be exactly
    // today in the collector's timezone, not "the last 24 hours".
    const today = isoToday();
    const yesterday = new Date(`${today}T12:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const eve = yesterday.toISOString().slice(0, 10);

    const payload = submissionPayload();
    payload.meta!.dateRange = { start: eve, end: today };
    payload.contributions![0].date = eve;
    payload.contributions![1].date = today;
    payload.contributions![1].clients![0].modelId = "gpt-5.5-codex";
    payload.contributions![1].clients![0].providerId = "openai";
    await submit(payload);

    const site = (await (await call("/api/site")).json()) as Record<string, any>;
    expectSiteContract(site);
    const day = site.ranges.day;
    expect(day.from).toBe(today);
    expect(day.totals).toMatchObject({ tokens: 500, activeDays: 1, firstDate: today, lastDate: today });
    expect(day.byModel).toEqual([expect.objectContaining({ model: "gpt-5.5-codex", tokens: 500 })]);
    expect(day.byClient).toEqual([expect.objectContaining({ client: "claude" })]);
    expect(day.byProvider).toEqual([expect.objectContaining({ provider: "openai" })]);
    // The wider ranges still see both days.
    expect(site.ranges.week.totals.tokens).toBe(1500);
  });

  it("stores dates past today but keeps them out of the payload", async () => {
    // Validation allows submissions up to two days ahead (clock skew, and
    // devices east of Asia/Shanghai are genuinely a day ahead for part of
    // the evening). The dashboard has nowhere to put such a row: every
    // window ends today, and Today's active time is matched by exact
    // date — so the payload is composed as of today and the row waits.
    const today = isoToday();
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const ahead = tomorrow.toISOString().slice(0, 10);

    const payload = submissionPayload();
    payload.meta!.dateRange = { start: today, end: ahead };
    payload.contributions![0].date = today;
    payload.contributions![1].date = ahead;
    payload.contributions![1].activeTimeMs = 1_800_000;
    const accepted = await submit(payload);
    expect(accepted.status).toBe(200);

    const site = (await (await call("/api/site")).json()) as Record<string, any>;
    expectSiteContract(site);
    expect(site.daily.map((day: any) => day.date)).toEqual([today]);
    for (const key of RANGE_KEYS) {
      expect(site.ranges[key].totals.tokens, `ranges.${key}`).toBe(1000);
      expect(site.ranges[key].totals.lastDate, `ranges.${key}`).toBe(today);
    }
    // The device inventory is bounded by the same date, or the all-time
    // totals and the per-device totals would disagree.
    expect(site.devices[0]).toMatchObject({ tokens: 1000, activeDays: 1 });
  });

  it("serializes absent device metadata as nulls, not gaps", async () => {
    await submit();
    const bare = submissionPayload();
    bare.device = { id: "device-test-2", name: "Bare Device" };
    bare.timeMetrics = undefined;
    bare.mcpServers = undefined;
    await submit(bare);

    const site = (await (await call("/api/site")).json()) as Record<string, any>;
    expectSiteContract(site);
    expect(site.devices).toHaveLength(2);
    const device = site.devices.find((d: any) => d.name === "Bare Device");
    expect(device).toMatchObject({
      sessions: null,
      activeMs: null,
      longestMs: null,
      maxConcurrent: null,
      mcpServers: null,
    });
  });

  it("splits clients and providers across the models behind them, biggest first", async () => {
    // The questions the marginals cannot answer: a coding agent running a
    // model from another vendor (byClient says "claude: 500", byModel says
    // "gpt-5.5-codex: 300" — only the join says the 300 came through Claude
    // Code), and which of a vendor's models its spend went to, summed over
    // every client that reached it.
    const payload = submissionPayload();
    payload.contributions![1].clients = [
      {
        client: "claude",
        modelId: "gpt-5.5-codex",
        providerId: "openai",
        tokens: { input: 100, output: 100, cacheRead: 100, cacheWrite: 0, reasoning: 0 },
        cost: 0.1,
        messages: 3,
        provenance: { schemaVersion: 3, messageCount: 3, modelCount: 1 },
      },
      {
        client: "claude",
        modelId: "claude-fable-5-thinking-max",
        providerId: "anthropic",
        tokens: { input: 100, output: 50, cacheRead: 50, cacheWrite: 0, reasoning: 0 },
        cost: 0.2,
        messages: 1,
        provenance: { schemaVersion: 3, messageCount: 1, modelCount: 1 },
      },
    ];
    await submit(payload);

    const site = (await (await call("/api/site")).json()) as Record<string, any>;
    expectSiteContract(site);
    const claude = site.ranges.all.byClient.find((row: any) => row.client === "claude");
    expect(claude.models).toEqual([
      { model: "gpt-5.5-codex", tokens: 300, cost: 0.1, messages: 3 },
      // Canonicalized before the join, so the cells agree with byModel.
      { model: "claude-fable-5", tokens: 200, cost: 0.2, messages: 1 },
    ]);
    const anthropic = site.ranges.all.byProvider.find((row: any) => row.provider === "anthropic");
    expect(anthropic.models).toEqual([
      // Cursor's day and Claude Code's day, under the one vendor.
      { model: "claude-opus-4-5", tokens: 1000, cost: 0.2, messages: 6 },
      { model: "claude-fable-5", tokens: 200, cost: 0.2, messages: 1 },
    ]);
  });

  it("keeps slices whose client or provider id shadows an Object member", async () => {
    // Nothing constrains a client id beyond "non-empty string", so an id
    // spelled `constructor` or `__proto__` reaches the per-day slice maps.
    // On a plain object those resolve inherited values, and the slice then
    // vanishes from the JSON while the day total still counts it: the
    // stacked chart under-reports and nothing errors.
    const payload = submissionPayload();
    payload.summary!.clients = ["cursor", "constructor", "__proto__"];
    payload.contributions![1].clients = [
      {
        client: "constructor",
        modelId: "m-a",
        providerId: "__proto__",
        tokens: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0.15,
        messages: 2,
        provenance: { schemaVersion: 3, messageCount: 2, modelCount: 1 },
      },
      {
        client: "__proto__",
        modelId: "m-b",
        providerId: "constructor",
        tokens: { input: 150, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0.15,
        messages: 2,
        provenance: { schemaVersion: 3, messageCount: 2, modelCount: 1 },
      },
    ];
    payload.contributions![1].totals = { tokens: 500, cost: 0.3, messages: 4 };
    await submit(payload);

    const site = (await (await call("/api/site")).json()) as Record<string, any>;
    expectSiteContract(site);
    const day = site.daily.find((d: any) => d.date === "2026-07-19");
    for (const dim of ["providers", "clients", "models"] as const) {
      const sliced = Object.values(day[dim]).reduce(
        (sum: number, slice: any) => sum + slice.tokens,
        0
      );
      expect(sliced, `daily.${dim} must account for the whole day`).toBe(day.tokens);
    }
    expect(Object.keys(day.clients).sort()).toEqual(["__proto__", "constructor"]);
  });

  it("rounds cost to microdollars instead of shipping float artefacts", async () => {
    // 0.1 + 0.2 is the canonical float-summation example: unrounded, the
    // all-time total serializes as 0.30000000000000004 and every such sum
    // in the payload spends bytes on digits nothing upstream knows.
    const payload = submissionPayload();
    payload.contributions![0].totals.cost = 0.1;
    payload.contributions![0].clients[0].cost = 0.1;
    payload.contributions![1].totals.cost = 0.2;
    payload.contributions![1].clients[0].cost = 0.2;
    payload.summary!.totalCost = 0.3;
    await submit(payload);

    const response = await call("/api/site");
    const raw = await response.text();
    expect(JSON.parse(raw).ranges.all.totals.cost).toBe(0.3);
    // Nowhere in the tree, not just on the total the assertion above reads.
    expect(raw).not.toMatch(/"cost":-?\d+\.\d{7,}/);
  });

  it("revalidates by ETag with a 304 that still carries CORS", async () => {
    await submit();
    const first = await call("/api/site");
    const etag = first.headers.get("ETag")!;
    const revalidated = await call("/api/site", { headers: { "If-None-Match": etag } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Weak-compare: edge compression may hand the browser a W/ prefix.
    const weak = await call("/api/site", { headers: { "If-None-Match": `W/${etag}` } });
    expect(weak.status).toBe(304);
  });

  it("recomposes inline when KV is empty or stale-versioned", async () => {
    await submit();
    await env.SITE_CACHE.delete("site");
    const cold = await call("/api/site");
    expect(cold.status).toBe(200);
    expectSiteContract((await cold.json()) as Record<string, any>);

    // A payload composed by an older schema version is recomposed on read.
    await env.SITE_CACHE.put("site", JSON.stringify({ old: true }), {
      metadata: { today: "2020-01-01", version: SITE_VERSION - 1, etag: '"stale"' },
    });
    const upgraded = await call("/api/site");
    const body = (await upgraded.json()) as Record<string, any>;
    expect(body.old).toBeUndefined();
    expect(body.schemaVersion).toBe(SITE_VERSION);
  });
});
