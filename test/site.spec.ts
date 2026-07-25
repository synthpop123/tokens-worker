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
import { SITE_VERSION } from "../src/site";
import { call, reset, submissionPayload, submit } from "./helpers";

beforeEach(() => reset());

const RANGE_KEYS = ["week", "month", "quarter", "all"] as const;
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
  }

  expect(Array.isArray(site.daily)).toBe(true);
  for (const day of site.daily) {
    expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const metric of ["tokens", "cost", "messages"]) {
      expect(typeof day[metric], `daily.${metric}`).toBe("number");
    }
    // The two stacking dimensions the trend chart Object.entries() over.
    for (const dim of ["providers", "clients"]) {
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
      expect.objectContaining({ model: "claude-opus-4-5", tokens: 1500, days: 2 }),
    ]);
    expect(site.daily).toHaveLength(2);
    expect(site.daily[0]).toMatchObject({
      date: "2026-07-18",
      tokens: 1000,
      active: 3_600_000,
      providers: { anthropic: expect.objectContaining({ tokens: 1000 }) },
      clients: { cursor: expect.objectContaining({ tokens: 1000 }) },
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
