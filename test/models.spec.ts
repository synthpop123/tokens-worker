/**
 * Pure tests for canonical model and provider ids — the rules /api/site
 * applies before aggregating, which is what makes per-effort model
 * variants and gateway provider spellings agree across its breakdowns.
 */

import { describe, expect, it } from "vitest";
import { canonicalModel, canonicalProvider, inferProviderFromModel } from "../src/models";

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
    expect(canonicalModel("cursor-grok-4.5")).toBe("grok-4.5");
    expect(canonicalModel("muse-spark-1.2-contributor")).toBe("muse-spark-1.2");
  });

  it("applies aliases after suffix stripping too", () => {
    expect(canonicalModel("claude-4-5-opus-thinking")).toBe("claude-opus-4-5");
    expect(canonicalModel("grok-4.5-build-free")).toBe("grok-4.5");
  });

  it("preserves Qwen product tiers that look like effort suffixes", () => {
    expect(canonicalModel("qwen3.8-plus")).toBe("qwen3.8-plus");
    expect(canonicalModel("qwen3.8-max")).toBe("qwen3.8-max");
  });

  it("leaves unknown names alone", () => {
    expect(canonicalModel("big-pickle")).toBe("big-pickle");
    expect(canonicalModel("unknown")).toBe("unknown");
  });
});

describe("canonicalProvider", () => {
  it("merges subscription-auth spellings into the vendor", () => {
    expect(canonicalProvider("openai-codex")).toBe("openai");
    expect(canonicalProvider("qwen")).toBe("alibaba");
    expect(canonicalProvider("anthropic")).toBe("anthropic");
    expect(canonicalProvider("")).toBe("");
  });

  it("re-attributes gateway providers to the model's vendor", () => {
    expect(canonicalProvider("zed.dev", "claude-sonnet-5-thinking")).toBe("anthropic");
    expect(canonicalProvider("zed.dev", "gpt-5.5")).toBe("openai");
    expect(canonicalProvider("opencode", "glm-4.7")).toBe("zai");
    expect(canonicalProvider("opencode", "kimi-k2.5")).toBe("moonshotai");
    expect(canonicalProvider("opencode-go", "deepseek-v4-flash")).toBe("deepseek");
    expect(canonicalProvider("opencode_go", "deepseek-v4-flash")).toBe("deepseek");
    expect(canonicalProvider("opencode_go", "gpt-5.6-luna")).toBe("openai");
    expect(canonicalProvider("opencode_go", "qwen3.8-max")).toBe("alibaba");
    expect(canonicalProvider("unknown", "gemini-3-pro")).toBe("google");
    expect(canonicalProvider("", "grok-4.5")).toBe("xai");
    expect(canonicalProvider("cursor", "cursor-grok-4.5")).toBe("xai");
    expect(canonicalProvider("opencode-go", "muse-spark-1.2-contributor")).toBe("meta");
    expect(canonicalProvider("opencode-go", "ox-alpha")).toBe("openrouter");
  });

  it("keeps gateway ids for models the rules cannot place", () => {
    expect(canonicalProvider("opencode", "big-pickle")).toBe("opencode");
    expect(canonicalProvider("opencode-go", "big-pickle")).toBe("opencode-go");
    expect(canonicalProvider("cursor", "composer-2.5")).toBe("cursor");
    expect(canonicalProvider("cursor", "auto")).toBe("cursor");
    expect(canonicalProvider("cursor", "premium-tool-call")).toBe("cursor");
  });

  it("never re-attributes vendor ids, even with model context", () => {
    expect(canonicalProvider("anthropic", "glm-4.7")).toBe("anthropic");
    expect(canonicalProvider("openai-codex", "gpt-5.6-sol")).toBe("openai");
    expect(canonicalProvider("moonshotai", "kimi-k2")).toBe("moonshotai");
    // Same row from a client whose models the user configured: its
    // `openai` names an OpenAI-compatible endpoint, so the model wins.
    expect(canonicalProvider("openai", "deepseek-v4-flash", "hermes")).toBe("deepseek");
    expect(canonicalProvider("openai", "gpt-5.6-sol", "hermes")).toBe("openai");
    // ...while a client whose provider id is a real claim keeps it.
    expect(canonicalProvider("openai", "deepseek-v4-flash", "codex")).toBe("openai");
  });

  it("passes gateway ids through unchanged without model context", () => {
    expect(canonicalProvider("zed.dev")).toBe("zed.dev");
    expect(canonicalProvider("opencode")).toBe("opencode");
    expect(canonicalProvider("opencode-go")).toBe("opencode-go");
  });
});

describe("inferProviderFromModel", () => {
  it("maps model families to vendors, matching the CLI rules", () => {
    expect(inferProviderFromModel("claude-opus-4-5")).toBe("anthropic");
    expect(inferProviderFromModel("fable-preview")).toBe("anthropic");
    expect(inferProviderFromModel("o3-mini")).toBe("openai");
    expect(inferProviderFromModel("deepseek-v3.2")).toBe("deepseek");
    expect(inferProviderFromModel("qwen3-coder")).toBe("alibaba");
    expect(inferProviderFromModel("mimo-v2.5")).toBe("xiaomi");
    expect(inferProviderFromModel("muse-spark-1.2")).toBe("meta");
    expect(inferProviderFromModel("ox-alpha")).toBe("openrouter");
  });

  it("requires delimiters on short tokens", () => {
    // "biglm" contains "glm" but not as a delimited token.
    expect(inferProviderFromModel("biglm")).toBeNull();
    expect(inferProviderFromModel("composer-2.5")).toBeNull();
    expect(inferProviderFromModel("big-pickle")).toBeNull();
  });
});
