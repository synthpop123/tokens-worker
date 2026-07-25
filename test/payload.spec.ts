/**
 * Pure tests for payload normalization (legacy aliases, model id
 * defaults) and the official mathematical-consistency validation:
 * date sanity, day-level and summary-level totals, cost-without-tokens
 * with the Cursor carve-out, and clientManifest gating.
 */

import { describe, expect, it } from "vitest";
import type { SubmissionPayload } from "../src/payload";
import {
  asNonNegativeInt,
  asNonNegativeNumber,
  normalizePayload,
  validatePayload,
} from "../src/payload";

const clientRow = (input: number, cost: number, overrides: Record<string, unknown> = {}) => ({
  client: "cursor",
  modelId: "gpt-5",
  providerId: "openai",
  tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  cost,
  messages: 1,
  provenance: { schemaVersion: 3, messageCount: 1, modelCount: 1 },
  ...overrides,
});

const validPayload = (): SubmissionPayload => ({
  meta: { generatedAt: "2026-07-20T00:00:00Z", version: "3.0.0", dateRange: { start: "2026-07-18", end: "2026-07-19" } },
  device: { id: "device-1", name: "Test" },
  summary: { totalTokens: 300, totalCost: 0.3, activeDays: 2, clients: ["cursor"] },
  contributions: [
    { date: "2026-07-18", totals: { tokens: 100, cost: 0.1, messages: 1 }, clients: [clientRow(100, 0.1)] },
    { date: "2026-07-19", totals: { tokens: 200, cost: 0.2, messages: 1 }, clients: [clientRow(200, 0.2)] },
  ],
});

describe("coercion helpers", () => {
  it("clamps to non-negative finite values", () => {
    expect(asNonNegativeInt(3.9)).toBe(3);
    expect(asNonNegativeInt(-1)).toBe(0);
    expect(asNonNegativeInt("12")).toBe(0);
    expect(asNonNegativeInt(Number.POSITIVE_INFINITY)).toBe(0);
    expect(asNonNegativeNumber(0.25)).toBe(0.25);
    expect(asNonNegativeNumber(-0.1)).toBe(0);
    expect(asNonNegativeNumber(Number.NaN)).toBe(0);
  });
});

describe("normalizePayload", () => {
  it("applies the kilocode→kilo alias everywhere and defaults empty model ids", () => {
    const payload = {
      summary: { clients: ["kilocode", "cursor"] },
      contributions: [
        {
          date: "2026-07-18",
          clients: [
            { client: "kilocode", modelId: "  gpt-5  " },
            { client: "cursor", modelId: "" },
          ],
        },
      ],
      clientManifest: { schemaVersion: 1, clients: [{ client: "kilocode", parserRevision: 1 }] },
    };
    normalizePayload(payload);
    expect(payload.summary.clients).toEqual(["kilo", "cursor"]);
    expect(payload.contributions[0].clients[0]).toMatchObject({ client: "kilo", modelId: "gpt-5" });
    expect(payload.contributions[0].clients[1].modelId).toBe("unknown");
    expect(payload.clientManifest.clients[0].client).toBe("kilo");
  });

  it("ignores non-object payloads without throwing", () => {
    expect(() => normalizePayload(null)).not.toThrow();
    expect(() => normalizePayload("x")).not.toThrow();
  });
});

describe("validatePayload", () => {
  it("accepts a consistent payload", () => {
    const { errors, warnings } = validatePayload(validPayload());
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("requires contributions to be an array", () => {
    const { errors } = validatePayload({} as SubmissionPayload);
    expect(errors).toEqual(["contributions must be an array"]);
  });

  it("rejects malformed, duplicate and far-future dates", () => {
    const payload = validPayload();
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    payload.contributions = [
      { date: "07/18/2026", totals: { tokens: 0, cost: 0, messages: 0 }, clients: [] },
      { date: "2026-07-18", totals: { tokens: 100, cost: 0.1, messages: 1 }, clients: [clientRow(100, 0.1)] },
      { date: "2026-07-18", totals: { tokens: 100, cost: 0.1, messages: 1 }, clients: [clientRow(100, 0.1)] },
      { date: future, totals: { tokens: 100, cost: 0.1, messages: 1 }, clients: [clientRow(100, 0.1)] },
    ];
    payload.summary = undefined;
    payload.meta = undefined;
    const { errors } = validatePayload(payload);
    expect(errors.some((e) => e.includes("Invalid contribution date"))).toBe(true);
    expect(errors.some((e) => e.includes("Duplicate date"))).toBe(true);
    expect(errors.some((e) => e.includes("Future date"))).toBe(true);
  });

  it("flags day totals that disagree with client sums", () => {
    const payload = validPayload();
    payload.contributions![0].totals.tokens = 5000;
    payload.summary = undefined;
    const { errors } = validatePayload(payload);
    expect(errors.some((e) => e.includes("client tokens"))).toBe(true);
  });

  it("flags cost submitted without tokens, honoring the Cursor carve-out", () => {
    const bare = validPayload();
    bare.contributions = [
      { date: "2026-07-18", totals: { tokens: 0, cost: 1, messages: 1 }, clients: [clientRow(0, 1)] },
    ];
    bare.summary = undefined;
    expect(validatePayload(bare).errors.some((e) => e.includes("Cost submitted without tokens"))).toBe(true);

    const carveOut = validPayload();
    carveOut.contributions = [
      {
        date: "2026-07-18",
        totals: { tokens: 0, cost: 1, messages: 1 },
        clients: [clientRow(0, 1, { modelId: "premium-tool-call" })],
      },
    ];
    carveOut.summary = undefined;
    expect(validatePayload(carveOut).errors).toEqual([]);
  });

  it("checks summary totals and warns on active-day mismatches", () => {
    const tokensOff = validPayload();
    tokensOff.summary!.totalTokens = 100000;
    expect(validatePayload(tokensOff).errors.some((e) => e.includes("Token total mismatch"))).toBe(true);

    const activeOff = validPayload();
    activeOff.summary!.activeDays = 7;
    const { errors, warnings } = validatePayload(activeOff);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("Active days mismatch"))).toBe(true);
  });

  it("counts message-only days as active (early-2025 Cursor logs)", () => {
    const payload = validPayload();
    payload.meta!.dateRange = { start: "2026-07-17", end: "2026-07-19" };
    payload.contributions!.push({
      date: "2026-07-17",
      totals: { tokens: 0, cost: 0, messages: 5 },
      clients: [],
    });
    payload.summary!.activeDays = 3;
    const { errors, warnings } = validatePayload(payload);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("warns when contributions fall outside meta.dateRange", () => {
    const payload = validPayload();
    payload.meta!.dateRange = { start: "2026-07-19", end: "2026-07-19" };
    const { warnings } = validatePayload(payload);
    expect(warnings.some((w) => w.includes("before dateRange.start"))).toBe(true);
  });

  it("gates the clientManifest: device identity, schemaVersion, coverage sanity", () => {
    const noDevice = validPayload();
    noDevice.device = undefined;
    noDevice.clientManifest = { schemaVersion: 1, clients: [] };
    const noDeviceResult = validatePayload(noDevice);
    expect(noDeviceResult.warnings.some((w) => w.includes("no device identity"))).toBe(true);
    expect(noDevice.clientManifest).toBeUndefined();

    const badVersion = validPayload();
    badVersion.clientManifest = { schemaVersion: 2, clients: [] };
    expect(validatePayload(badVersion).warnings.some((w) => w.includes("unsupported schemaVersion"))).toBe(true);
    expect(badVersion.clientManifest).toBeUndefined();

    const badCoverage = validPayload();
    badCoverage.clientManifest = {
      schemaVersion: 1,
      clients: [{ client: "cursor", parserRevision: 3, coverage: { mode: "full", start: "2026-07-20", end: "2026-07-01" } }],
    };
    expect(validatePayload(badCoverage).errors.some((e) => e.includes("coverage for cursor is invalid"))).toBe(true);
  });
});
