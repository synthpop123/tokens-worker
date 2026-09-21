/**
 * Canonical model and provider ids, shared by every aggregation endpoint.
 *
 * The CLIs report one model id per (model x reasoning effort x serving
 * tier): `claude-fable-5-thinking-max`, `gpt-5-codex-high`,
 * `composer-2-fast`, `grok-bot-default`, ... For aggregate views those are all the same
 * model, so /api/site canonicalizes ids *before* aggregating — which is
 * why its per-day model slices agree with its byModel breakdown.
 *
 * Provider ids are canonicalized to **model vendors**, and the model name
 * is what decides. The reported id is only ever whatever the row's client
 * logged: a vendor (`anthropic`), a subscription endpoint (`openai-codex`),
 * a gateway (`zed.dev`, `opencode`), or a proxy the user named themselves
 * in a client config (`gpt-load`, `cliproxyapi, gptload`). That last kind
 * is open-ended, so no list of ids to demote could stay complete — instead
 * canonicalProvider takes the vendor the model name implies
 * (inferProviderFromModel, the rules the CLI's cursor parser uses) and
 * keeps the reported id only for models the rules can't place (composer,
 * big-pickle, ...), matching the CLI's own Cursor fallback. A vendor
 * reselling another vendor's model therefore lands under the model's
 * vendor, which is what "canonical provider" means here.
 *
 * Raw spellings are what D1 stores, so nothing here is lossy: the matrix
 * keeps every id the CLIs reported and canonicalization happens on the
 * way out.
 *
 * Maintenance: when a new model shows up with a spelling the rules get
 * wrong, add an ALIASES entry. Mapping a raw name to itself pins it and
 * skips the suffix rules entirely (and the Cursor prefix). Family-wide
 * product tiers that resemble effort suffixes belong in
 * PRODUCT_TIER_MODELS instead (Qwen Plus/Max).
 * A new vendor extends inferProviderFromModel (keep its family recognition
 * in step with the CLI's provider_identity.rs; this Worker normalizes the
 * final vendor ids) — a new proxy or gateway needs no entry at all.
 */


const EFFORT = "minimal|low|medium|high|xhigh|max";

/** Tried in order, repeatedly, until the name stops changing. */
const SUFFIX_RULES: RegExp[] = [
  new RegExp(`-(?:${EFFORT})-thinking$`), // ...-high-thinking
  new RegExp(`-thinking(?:-(?:${EFFORT}))?$`), // ...-thinking[-max]
  new RegExp(`-(?:${EFFORT})$`), // ...-medium (bare effort)
  /-(?:fast|free|default)$/, // serving tier, and the grok CLI's "no tier chosen"
];

/** Model ids arrive from CLI payloads, so every lookup table keyed by one
 *  is a Map — a plain object would resolve `constructor` and `toString`
 *  off Object.prototype. */
const ALIASES = new Map<string, string>([
  // Cursor's Auto mode, which the CLI's cursor parser has spelled two ways
  // (`auto` and, in the rows this account collected through 2026-09-12,
  // `default`). One mode, so one id — and `auto` is the readable one, since
  // the dashboard title-cases whatever arrives. The bare name is Cursor's
  // alone: every other client reports a real model, and the grok CLI's "no
  // tier chosen" is a *suffix* (`grok-bot-default`) the rules below strip.
  ["default", "auto"],
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
  // Meta Muse Spark contributor tier shares one canonical id.
  ["muse-spark-1.2-contributor", "muse-spark-1.2"],
]);

const PRODUCT_TIER_MODELS = /^qwen.*-(?:plus|max)$/i;

/**
 * Cursor prefixes the vendor's model id when it serves one through its own
 * routing (`cursor-grok-4.6`), so the same model arrives under two names
 * depending on the client. The prefix only comes off when what is left is a
 * model the vendor rules recognize — Cursor's own models (`cursor-small`)
 * are not a prefixed anything, and stripping would leave them unreadable.
 */
const CURSOR_PREFIX = /^cursor-/;

export function canonicalModel(raw: string): string {
  const pinned = ALIASES.get(raw);
  if (pinned) return pinned;
  if (PRODUCT_TIER_MODELS.test(raw)) return raw;
  let name = raw;
  const unprefixed = name.replace(CURSOR_PREFIX, "");
  if (unprefixed !== name && inferProviderFromModel(unprefixed)) name = unprefixed;
  for (let prev = ""; prev !== name; ) {
    prev = name;
    for (const rule of SUFFIX_RULES) name = name.replace(rule, "");
  }
  return ALIASES.get(name) ?? name;
}

/** Only reached for models the vendor rules can't place, or when the
 *  caller has no model context at all. */
const PROVIDER_ALIASES = new Map<string, string>([
  // pi's OAuth-through-ChatGPT provider — OpenAI's Codex subscription.
  ["openai-codex", "openai"],
  // Qwen is Alibaba's model family; direct Qwen CLI rows use this id.
  ["qwen", "alibaba"],
  // Some OpenCode parsers spell the OpenCode Go gateway with an underscore.
  ["opencode_go", "opencode-go"],
]);

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
  if (m.includes("llama") || containsDelimited(m, "meta") || m.includes("muse"))
    return "meta";
  // OpenCode Go anonymous OpenRouter routes (Ox Alpha, ...).
  if (m === "ox-alpha" || /^ox-[a-z0-9-]+$/.test(m)) return "openrouter";
  if (m.includes("qwen")) return "alibaba";
  if (m.includes("fugu")) return "sakana";
  if (containsDelimited(m, "kimi")) return "moonshotai";
  if (containsDelimited(m, "mimo")) return "xiaomi";
  if (containsDelimited(m, "glm")) return "zai";
  return null;
}

/**
 * Canonical provider id: the vendor of the row's model whenever the rules
 * can place it, otherwise the reported id with alias spellings collapsed.
 * Without model context (already-aggregated ids) only the aliases apply.
 */
export function canonicalProvider(raw: string, model?: string): string {
  const inferred = model === undefined ? null : inferProviderFromModel(model);
  return inferred ?? PROVIDER_ALIASES.get(raw) ?? raw;
}
