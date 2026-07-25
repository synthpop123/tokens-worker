/**
 * Pure tests for the merge engine: incoming-day aggregation, revision
 * floors, the per-client regression guard, authoritative coverage
 * tombstoning, and the float-tolerant day equality that keeps periodic
 * resubmits from rewriting unchanged days.
 */

import { describe, expect, it } from "vitest";
import type { ClientContribution } from "../src/payload";
import type { DayState } from "../src/merge";
import {
  aggregateIncomingDay,
  clientTokens,
  collectSubmittedClients,
  daysEqual,
  deriveRevisionFloors,
  extractCoverages,
  mergeDay,
  modelKey,
} from "../src/merge";

const metrics = (input: number, cost = 0) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  messages: 1,
  cost,
});

const contribution = (
  client: string,
  modelId: string,
  input: number,
  revision = 1,
  providerId?: string
): ClientContribution => ({
  client,
  modelId,
  providerId,
  tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  cost: 0,
  messages: 1,
  provenance: { schemaVersion: revision, messageCount: 1, modelCount: 1 },
});

const dayState = (
  entries: Array<[client: string, revision: number, model: string, input: number]>
): DayState => {
  const day: DayState = new Map();
  for (const [client, revision, model, input] of entries) {
    const existing = day.get(client) ?? { revision, models: new Map() };
    existing.models.set(modelKey(model, ""), metrics(input));
    day.set(client, existing);
  }
  return day;
};

describe("aggregateIncomingDay", () => {
  it("sums duplicate (model, provider) rows within a client", () => {
    const day = aggregateIncomingDay([
      contribution("cursor", "gpt-5", 100, 2, "openai"),
      contribution("cursor", "gpt-5", 50, 2, "openai"),
    ]);
    const cursor = day.get("cursor");
    expect(cursor?.models.size).toBe(1);
    expect(cursor?.models.get(modelKey("gpt-5", "openai"))?.input).toBe(150);
  });

  it("keeps the minimum schemaVersion across a client's rows (official)", () => {
    const day = aggregateIncomingDay([
      contribution("cursor", "gpt-5", 100, 3),
      contribution("cursor", "claude-opus-4", 50, 2),
    ]);
    expect(day.get("cursor")?.revision).toBe(2);
  });

  it("defaults missing provenance to revision 1 and providerId to empty", () => {
    const day = aggregateIncomingDay([
      { ...contribution("zed", "gpt-5", 10), provenance: undefined, providerId: undefined },
    ]);
    expect(day.get("zed")?.revision).toBe(1);
    expect(day.get("zed")?.models.has(modelKey("gpt-5", ""))).toBe(true);
  });
});

describe("deriveRevisionFloors", () => {
  it("takes the max stored revision per client across all days", () => {
    const stored: Map<string, DayState> = new Map([
      ["2026-07-01", dayState([["cursor", 2, "gpt-5", 10]])],
      ["2026-07-02", dayState([["cursor", 4, "gpt-5", 10], ["claude", 1, "opus", 5]])],
    ]);
    const floors = deriveRevisionFloors(stored);
    expect(floors.get("cursor")).toBe(4);
    expect(floors.get("claude")).toBe(1);
  });
});

describe("extractCoverages", () => {
  it("keeps only mode=full windows", () => {
    const coverages = extractCoverages([
      { client: "cursor", parserRevision: 3, coverage: { mode: "full", start: "2026-07-01", end: "2026-07-10" } },
      { client: "claude", parserRevision: 3, coverage: { mode: "partial", start: "2026-07-01", end: "2026-07-10" } },
      { client: "zed", parserRevision: 3 },
    ]);
    expect(coverages).toEqual([{ client: "cursor", start: "2026-07-01", end: "2026-07-10" }]);
  });
});

describe("mergeDay", () => {
  const submitted = new Set(["cursor"]);
  const none = new Set<string>();

  it("creates a new day from incoming data", () => {
    const incoming = aggregateIncomingDay([contribution("cursor", "gpt-5", 100, 2)]);
    const { merged, warnings } = mergeDay("2026-07-01", undefined, incoming, submitted, none, []);
    expect(warnings).toEqual([]);
    expect(clientTokens(merged.get("cursor")!)).toBe(100);
  });

  it("preserves stored data when a same-revision resubmit would reduce tokens", () => {
    const stored = dayState([["cursor", 2, "gpt-5", 100]]);
    const incoming = aggregateIncomingDay([contribution("cursor", "gpt-5", 60, 2)]);
    const { merged, warnings } = mergeDay("2026-07-01", stored, incoming, submitted, none, []);
    expect(clientTokens(merged.get("cursor")!)).toBe(100);
    expect(warnings.some((w) => w.includes("would reduce"))).toBe(true);
  });

  it("lets a newer parser revision reduce tokens", () => {
    const stored = dayState([["cursor", 2, "gpt-5", 100]]);
    const incoming = aggregateIncomingDay([contribution("cursor", "gpt-5", 60, 3)]);
    const { merged, warnings } = mergeDay("2026-07-01", stored, incoming, submitted, none, []);
    expect(warnings).toEqual([]);
    expect(clientTokens(merged.get("cursor")!)).toBe(60);
  });

  it("preserves stored data against an older parser revision", () => {
    const stored = dayState([["cursor", 3, "gpt-5", 100]]);
    const incoming = aggregateIncomingDay([contribution("cursor", "gpt-5", 200, 2)]);
    const { merged, warnings } = mergeDay("2026-07-01", stored, incoming, submitted, none, []);
    expect(clientTokens(merged.get("cursor")!)).toBe(100);
    expect(warnings.some((w) => w.includes("older than stored revision"))).toBe(true);
  });

  it("preserves a client that disappeared from the resubmit while it still has tokens", () => {
    const stored = dayState([["cursor", 2, "gpt-5", 100]]);
    const { merged, warnings } = mergeDay("2026-07-01", stored, new Map(), submitted, none, []);
    expect(clientTokens(merged.get("cursor")!)).toBe(100);
    expect(warnings.some((w) => w.includes("disappeared"))).toBe(true);
  });

  it("drops a disappeared client that had no tokens", () => {
    const stored: DayState = new Map([
      ["cursor", { revision: 2, models: new Map([[modelKey("gpt-5", ""), metrics(0)]]) }],
    ]);
    const { merged, warnings } = mergeDay("2026-07-01", stored, new Map(), submitted, none, []);
    expect(merged.has("cursor")).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("skips clients rejected by the revision floor", () => {
    const stored = dayState([["cursor", 3, "gpt-5", 100]]);
    const incoming = aggregateIncomingDay([contribution("cursor", "gpt-5", 500, 1)]);
    const rejected = new Set(["cursor"]);
    const { merged } = mergeDay("2026-07-01", stored, incoming, submitted, rejected, []);
    expect(clientTokens(merged.get("cursor")!)).toBe(100);
  });

  it("tombstones covered clients on days the submission no longer mentions", () => {
    const stored = dayState([["cursor", 2, "gpt-5", 100], ["claude", 2, "opus", 50]]);
    const coverages = [{ client: "cursor", start: "2026-07-01", end: "2026-07-31" }];
    const { merged, warnings } = mergeDay("2026-07-05", stored, undefined, submitted, none, coverages);
    expect(merged.has("cursor")).toBe(false);
    expect(clientTokens(merged.get("claude")!)).toBe(50);
    expect(warnings.some((w) => w.includes("authoritative replacement coverage"))).toBe(true);
  });

  it("replaces covered clients silently when the submission still carries them", () => {
    const stored = dayState([["cursor", 2, "gpt-5", 100]]);
    const incoming = aggregateIncomingDay([contribution("cursor", "gpt-5", 40, 2)]);
    const coverages = [{ client: "cursor", start: "2026-07-01", end: "2026-07-31" }];
    const { merged, warnings } = mergeDay("2026-07-05", stored, incoming, submitted, none, coverages);
    // Coverage removed the stored rows first, so the regression guard has
    // nothing to preserve: the 40-token rescan is authoritative.
    expect(clientTokens(merged.get("cursor")!)).toBe(40);
    expect(warnings).toEqual([]);
  });

  it("leaves days outside the coverage window untouched", () => {
    const stored = dayState([["cursor", 2, "gpt-5", 100]]);
    const coverages = [{ client: "cursor", start: "2026-07-10", end: "2026-07-31" }];
    const { merged } = mergeDay("2026-07-05", stored, undefined, submitted, none, coverages);
    expect(clientTokens(merged.get("cursor")!)).toBe(100);
  });
});

describe("daysEqual", () => {
  const base = () => dayState([["cursor", 2, "gpt-5", 100]]);

  it("treats identical days as equal", () => {
    expect(daysEqual(base(), base())).toBe(true);
  });

  it("tolerates sub-1e-9 relative cost drift (float re-summation)", () => {
    const a = base();
    const b = base();
    a.get("cursor")!.models.get(modelKey("gpt-5", ""))!.cost = 1.0;
    b.get("cursor")!.models.get(modelKey("gpt-5", ""))!.cost = 1.0 + 1e-12;
    expect(daysEqual(a, b)).toBe(true);
  });

  it("detects real changes", () => {
    const b = base();
    b.get("cursor")!.models.get(modelKey("gpt-5", ""))!.input = 101;
    expect(daysEqual(base(), b)).toBe(false);
    expect(daysEqual(undefined, base())).toBe(false);
    expect(daysEqual(base(), dayState([["cursor", 2, "gpt-5", 100], ["zed", 1, "gpt-5", 1]]))).toBe(false);
  });
});

describe("collectSubmittedClients", () => {
  it("unions summary clients and contribution clients", () => {
    const set = collectSubmittedClients(
      ["cursor", ""],
      [{ date: "2026-07-01", totals: { tokens: 0, cost: 0, messages: 0 }, clients: [contribution("claude", "opus", 1)] }]
    );
    expect(set.has("cursor")).toBe(true);
    expect(set.has("claude")).toBe(true);
    expect(set.has("")).toBe(false);
  });

  it("adds kilocode when kilo is present (alias tombstone guard)", () => {
    const set = collectSubmittedClients(["kilo"], []);
    expect(set.has("kilocode")).toBe(true);
  });
});
