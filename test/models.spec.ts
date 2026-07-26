/**
 * Pure tests for canonical model/provider ids and aggregate-row merging —
 * the rules every aggregation endpoint (and /api/site) relies on to make
 * per-effort model variants and provider spellings agree.
 */

import { describe, expect, it } from "vitest";
import { canonicalModel, canonicalProvider, mergeRows, type ModelMetrics } from "../src/models";

describe("canonicalModel", () => {
  it("strips effort/thinking/serving-tier suffixes, repeatedly", () => {
    expect(canonicalModel("claude-fable-5-thinking-max")).toBe("claude-fable-5");
    expect(canonicalModel("gpt-5-codex-high")).toBe("gpt-5-codex");
    expect(canonicalModel("composer-2-fast")).toBe("composer-2");
    expect(canonicalModel("gpt-5-high-thinking")).toBe("gpt-5");
    expect(canonicalModel("kimi-k2-free")).toBe("kimi-k2");
  });

  it("maps aliased spellings (family-last Anthropic ids, dated snapshots)", () => {
    expect(canonicalModel("claude-4-5-opus")).toBe("claude-opus-4-5");
    expect(canonicalModel("claude-4-6-sonnet")).toBe("claude-sonnet-4-6");
    expect(canonicalModel("gemini-2.5-pro-exp-03-25")).toBe("gemini-2.5-pro");
    expect(canonicalModel("gemini-3-pro-preview")).toBe("gemini-3-pro");
    expect(canonicalModel("kimi-k2-instruct")).toBe("kimi-k2");
    expect(canonicalModel("kimi-k2-instruct-0905")).toBe("kimi-k2");
    expect(canonicalModel("grok-4.5-build")).toBe("grok-4.5");
  });

  it("applies aliases after suffix stripping too", () => {
    expect(canonicalModel("claude-4-5-opus-thinking")).toBe("claude-opus-4-5");
    expect(canonicalModel("grok-4.5-build-free")).toBe("grok-4.5");
  });

  it("leaves unknown names alone", () => {
    expect(canonicalModel("big-pickle")).toBe("big-pickle");
    expect(canonicalModel("unknown")).toBe("unknown");
  });
});

describe("canonicalProvider", () => {
  it("merges subscription-auth spellings into the vendor", () => {
    expect(canonicalProvider("openai-codex")).toBe("openai");
    expect(canonicalProvider("anthropic")).toBe("anthropic");
    expect(canonicalProvider("")).toBe("");
  });
});

const row = (
  model: string,
  tokens: number,
  extra: Record<string, unknown> = {}
): ModelMetrics & { model: string } & Record<string, unknown> => ({
  model,
  input: tokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  tokens,
  messages: 1,
  cost: tokens / 1000,
  ...extra,
});

describe("mergeRows", () => {
  it("sums metrics of rows sharing a canonical model and unions providers", () => {
    const merged = mergeRows([
      row("gpt-5-high", 100, { providers: "openai" }),
      row("gpt-5", 50, { providers: "openai-codex,azure" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].model).toBe("gpt-5");
    expect(merged[0].tokens).toBe(150);
    expect(merged[0].messages).toBe(2);
    expect(merged[0].cost).toBeCloseTo(0.15);
    expect(merged[0].providers).toBe("openai,azure");
  });

  it("scopes merging by groupBy (per-period timeseries rows)", () => {
    type Series = ModelMetrics & { model: string; period: string };
    const merged = mergeRows<Series>(
      [
        { ...row("gpt-5-high", 100), period: "2026-07" },
        { ...row("gpt-5", 10), period: "2026-06" },
      ],
      { groupBy: (r) => r.period }
    );
    expect(merged).toHaveLength(2);
  });

  it("canonicalizes an arbitrary field (providers)", () => {
    type ProviderRow = ModelMetrics & { provider: string };
    const rows: ProviderRow[] = [
      { ...row("x", 1), provider: "openai-codex" } as unknown as ProviderRow,
      { ...row("x", 2), provider: "openai" } as unknown as ProviderRow,
    ];
    const merged = mergeRows(rows, { field: "provider", canonicalize: canonicalProvider });
    expect(merged).toHaveLength(1);
    expect(merged[0].provider).toBe("openai");
    expect(merged[0].tokens).toBe(3);
  });
});
