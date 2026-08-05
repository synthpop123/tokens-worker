/**
 * Canonical model and provider ids, shared by every aggregation endpoint.
 *
 * The CLIs report one model id per (model x reasoning effort x serving
 * tier): `claude-fable-5-thinking-max`, `gpt-5-codex-high`,
 * `composer-2-fast`, ... For aggregate views those are all the same
 * model, so /api/site canonicalizes ids *before* aggregating — which is
 * why its per-day model slices agree with its byModel breakdown.
 *
 * Provider ids are canonicalized to **model vendors**, because the raw ids
 * mix two semantics: clients whose logs record who served the request
 * report their own gateway (Zed says `zed.dev` for a Claude model,
 * OpenCode says `opencode` for GLM through its zen gateway, pi spells its
 * subscription-auth endpoint `openai-codex`), while the CLI's cursor
 * parser infers the vendor from the model name because Cursor's export has
 * no provider column. So canonicalProvider applies the alias table and —
 * given the row's model — re-attributes by those same model-name rules
 * (inferProviderFromModel) every row whose provider id names no vendor:
 * a gateway id, or any id reported by a client that serves no models of
 * its own. Models the rules can't place (composer, big-pickle, ...) stay
 * under the reported id, matching the CLI's own Cursor fallback.
 *
 * Raw spellings are what D1 stores, so nothing here is lossy: the matrix
 * keeps every id the CLIs reported and canonicalization happens on the
 * way out.
 *
 * Maintenance: when a new model shows up with a spelling the rules get
 * wrong, add an ALIASES entry. Mapping a raw name to itself pins it and
 * skips the suffix rules entirely. Family-wide product tiers that resemble
 * effort suffixes belong in PRODUCT_TIER_MODELS instead (Qwen Plus/Max).
 * When a new vendor's models appear behind a gateway provider, extend
 * inferProviderFromModel (keep its family recognition in step with the CLI's
 * provider_identity.rs; this Worker normalizes the final vendor ids).
 */


const EFFORT = "minimal|low|medium|high|xhigh|max";

/** Tried in order, repeatedly, until the name stops changing. */
const SUFFIX_RULES: RegExp[] = [
  new RegExp(`-(?:${EFFORT})-thinking$`), // ...-high-thinking
  new RegExp(`-thinking(?:-(?:${EFFORT}))?$`), // ...-thinking[-max]
  new RegExp(`-(?:${EFFORT})$`), // ...-medium (bare effort)
  /-(?:fast|free)$/, // serving tier
];

/** Model ids arrive from CLI payloads, so every lookup table keyed by one
 *  is a Map — a plain object would resolve `constructor` and `toString`
 *  off Object.prototype. */
const ALIASES = new Map<string, string>([
  // Cursor spells Anthropic 4.x models family-last.
  ["claude-4-opus", "claude-opus-4"],
  ["claude-4-5-opus", "claude-opus-4-5"],
  ["claude-4-6-opus", "claude-opus-4-6"],
  ["claude-4-sonnet", "claude-sonnet-4"],
  ["claude-4-5-sonnet", "claude-sonnet-4-5"],
  ["claude-4-6-sonnet", "claude-sonnet-4-6"],
  // Dated snapshots and preview/variant spellings of the same model.
  // (Alias lookup is single-hop, so every spelling maps straight to the
  // final name — no chaining through an intermediate alias.)
  ["kimi-k2-instruct", "kimi-k2"],
  ["kimi-k2-instruct-0905", "kimi-k2"],
  ["gemini-2.5-pro-exp-03-25", "gemini-2.5-pro"],
  ["gemini-2.5-pro-preview-05-06", "gemini-2.5-pro"],
  ["gemini-3-pro-preview", "gemini-3-pro"],
  // The grok CLI spells its agentic tier as a "-build" model (reported as
  // grok-4.5-build-free; the suffix rules strip the serving tier first).
  ["grok-4.5-build", "grok-4.5"],
  // Cursor prefixes the vendor model id when served through its own routing.
  ["cursor-grok-4.5", "grok-4.5"],
]);

const PRODUCT_TIER_MODELS = /^qwen.*-(?:plus|max)$/i;

export function canonicalModel(raw: string): string {
  const pinned = ALIASES.get(raw);
  if (pinned) return pinned;
  if (PRODUCT_TIER_MODELS.test(raw)) return raw;
  let name = raw;
  for (let prev = ""; prev !== name; ) {
    prev = name;
    for (const rule of SUFFIX_RULES) name = name.replace(rule, "");
  }
  return ALIASES.get(name) ?? name;
}

const PROVIDER_ALIASES = new Map<string, string>([
  // pi's OAuth-through-ChatGPT provider — OpenAI's Codex subscription.
  ["openai-codex", "openai"],
  // Qwen is Alibaba's model family; direct Qwen CLI rows use this id.
  ["qwen", "alibaba"],
  // Some OpenCode parsers spell the OpenCode Go gateway with an underscore.
  ["opencode_go", "opencode-go"],
]);

/**
 * Provider ids that name the serving gateway (the client's own endpoint)
 * or nothing at all — not a model vendor. Rows carrying these get
 * re-attributed by model name when the caller can supply one.
 */
const GATEWAY_PROVIDERS = new Set([
  "cursor",
  "opencode",
  "opencode-go",
  "zed.dev",
  "unknown",
  "",
]);

/**
 * Clients that serve no models of their own. Everything they run arrives
 * through an endpoint they merely dial, so the provider they report is
 * the API dialect rather than the vendor: Hermes Agent logged DeepSeek V4
 * Flash under `openai` (an OpenAI-compatible base URL) on one day and
 * under `opencode_go` on the next. A vendor id is normally authoritative
 * and passes through untouched — from these clients it is not, so their
 * rows take the model-name rules like a gateway id does.
 */
const GATEWAY_CLIENTS = new Set(["hermes"]);

/** True when haystack contains needle bounded by non-alphanumerics. */
function containsDelimited(haystack: string, needle: string): boolean {
  const alnum = /[a-z0-9]/i;
  for (let pos = haystack.indexOf(needle); pos !== -1; pos = haystack.indexOf(needle, pos + 1)) {
    const after = pos + needle.length;
    const beforeOk = pos === 0 || !alnum.test(haystack[pos - 1]);
    const afterOk = after === haystack.length || !alnum.test(haystack[after]);
    if (beforeOk && afterOk) return true;
  }
  return false;
}

/**
 * Vendor inference from a model name — the family checks are a port of the
 * CLI's `provider_identity::inferred_provider_from_model`; returned ids use
 * this Worker's canonical model-vendor vocabulary (for example Qwen →
 * Alibaba). Bare substring checks are deliberate (spellings vary per client); the
 * delimited checks guard short tokens against matches inside other words.
 */
export function inferProviderFromModel(model: string): string | null {
  const m = model.toLowerCase();
  if (
    m.includes("claude") ||
    m.includes("anthropic") ||
    containsDelimited(m, "opus") ||
    containsDelimited(m, "sonnet") ||
    containsDelimited(m, "haiku") ||
    containsDelimited(m, "fable")
  ) {
    return "anthropic";
  }
  if (
    m.includes("gpt") ||
    m.includes("openai") ||
    containsDelimited(m, "o1") ||
    containsDelimited(m, "o3") ||
    containsDelimited(m, "o4")
  ) {
    return "openai";
  }
  if (m.includes("gemini") || m.includes("google")) return "google";
  if (m.includes("grok")) return "xai";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("minimax")) return "minimax";
  if (m.includes("mistral") || m.includes("mixtral")) return "mistral";
  if (m.includes("llama") || containsDelimited(m, "meta")) return "meta";
  if (m.includes("qwen")) return "alibaba";
  if (m.includes("fugu")) return "sakana";
  if (containsDelimited(m, "kimi")) return "moonshotai";
  if (containsDelimited(m, "mimo")) return "xiaomi";
  if (containsDelimited(m, "glm")) return "zai";
  return null;
}

/**
 * Canonical provider id: alias spellings collapse into the vendor, and —
 * when the caller supplies the row's model — the ids that name no vendor
 * are re-attributed by model name. Two ways a row qualifies: a gateway
 * provider id (zed.dev, opencode, opencode-go, cursor, unknown), or a
 * client that has no models of its own, whose provider id is a dialect
 * whatever it says. Models the rules can't place keep the reported id.
 * Without model context (already-aggregated ids) nothing is re-attributed.
 */
export function canonicalProvider(raw: string, model?: string, client?: string): string {
  const provider = PROVIDER_ALIASES.get(raw) ?? raw;
  if (model === undefined) return provider;
  const untrusted =
    GATEWAY_PROVIDERS.has(provider) || (client !== undefined && GATEWAY_CLIENTS.has(client));
  return untrusted ? (inferProviderFromModel(model) ?? provider) : provider;
}
