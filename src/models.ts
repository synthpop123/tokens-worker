/**
 * Canonical model and provider ids, shared by every aggregation endpoint.
 *
 * The CLIs report one model id per (model x reasoning effort x serving
 * tier): `claude-fable-5-thinking-max`, `gpt-5-codex-high`,
 * `composer-2-fast`, ... For aggregate views those are all the same model,
 * so /api/site, /api/stats, /api/breakdown and /api/timeseries merge rows
 * under a canonical name (mergeRows below).
 *
 * Provider ids are canonicalized to **model vendors**. The raw ids mix two
 * semantics: clients whose logs record who served the request report their
 * own gateway (Zed threads say `zed.dev` for a Claude model, OpenCode says
 * `opencode` for GLM through its zen gateway, pi spells its
 * subscription-auth endpoint `openai-codex`), while the tokens CLI's
 * cursor parser infers the vendor from the model name because Cursor's
 * export has no provider column. Aggregate views want one answer, so
 * canonicalProvider applies the alias table and — given the row's model —
 * re-attributes gateway rows by the same model-name rules the CLI uses
 * (inferProviderFromModel below). Models the rules can't place (composer,
 * big-pickle, ...) stay under the gateway id, matching the CLI's own
 * fallback for Cursor. /api/graph keeps all raw spellings — it is the
 * full-fidelity export — and raw ids remain the filter vocabulary
 * (/api/meta, `model=` / `provider=` params).
 *
 * Maintenance: when a new model shows up with a spelling the rules get
 * wrong, add an ALIASES entry. Mapping a raw name to itself pins it and
 * skips the suffix rules entirely (e.g. a model genuinely named "*-max").
 * When a new vendor's models appear behind a gateway provider, extend
 * inferProviderFromModel (keep it in step with the CLI's
 * provider_identity.rs).
 */

const EFFORT = "minimal|low|medium|high|xhigh|max";

/** Tried in order, repeatedly, until the name stops changing. */
const SUFFIX_RULES: RegExp[] = [
  new RegExp(`-(?:${EFFORT})-thinking$`), // ...-high-thinking
  new RegExp(`-thinking(?:-(?:${EFFORT}))?$`), // ...-thinking[-max]
  new RegExp(`-(?:${EFFORT})$`), // ...-medium (bare effort)
  /-(?:fast|free)$/, // serving tier
];

const ALIASES: Record<string, string> = {
  // Cursor spells Anthropic 4.x models family-last.
  "claude-4-opus": "claude-opus-4",
  "claude-4-5-opus": "claude-opus-4-5",
  "claude-4-6-opus": "claude-opus-4-6",
  "claude-4-sonnet": "claude-sonnet-4",
  "claude-4-5-sonnet": "claude-sonnet-4-5",
  "claude-4-6-sonnet": "claude-sonnet-4-6",
  // Dated snapshots and preview/variant spellings of the same model.
  // (Alias lookup is single-hop, so every spelling maps straight to the
  // final name — no chaining through an intermediate alias.)
  "kimi-k2-instruct": "kimi-k2",
  "kimi-k2-instruct-0905": "kimi-k2",
  "gemini-2.5-pro-exp-03-25": "gemini-2.5-pro",
  "gemini-2.5-pro-preview-05-06": "gemini-2.5-pro",
  "gemini-3-pro-preview": "gemini-3-pro",
  // The grok CLI spells its agentic tier as a "-build" model (reported as
  // grok-4.5-build-free; the suffix rules strip the serving tier first).
  "grok-4.5-build": "grok-4.5",
};

export function canonicalModel(raw: string): string {
  if (raw in ALIASES) return ALIASES[raw];
  let name = raw;
  for (let prev = ""; prev !== name; ) {
    prev = name;
    for (const rule of SUFFIX_RULES) name = name.replace(rule, "");
  }
  return ALIASES[name] ?? name;
}

const PROVIDER_ALIASES: Record<string, string> = {
  // pi's OAuth-through-ChatGPT provider — OpenAI's Codex subscription.
  "openai-codex": "openai",
};

/**
 * Provider ids that name the serving gateway (the client's own endpoint)
 * or nothing at all — not a model vendor. Rows carrying these get
 * re-attributed by model name when the caller can supply one.
 */
const GATEWAY_PROVIDERS = new Set(["cursor", "opencode", "zed.dev", "unknown", ""]);

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
 * Vendor inference from a model name — a port of the CLI's
 * `provider_identity::inferred_provider_from_model` (its cursor parser
 * attributes Cursor's provider-less usage.csv rows with exactly these
 * rules, so gateway rows re-attributed here agree with cursor rows).
 * Bare substring checks are deliberate (spellings vary per client); the
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
  if (m.includes("qwen")) return "qwen";
  if (m.includes("fugu")) return "sakana";
  if (containsDelimited(m, "kimi")) return "moonshotai";
  if (containsDelimited(m, "mimo")) return "xiaomi";
  if (containsDelimited(m, "glm")) return "zai";
  return null;
}

/**
 * Canonical provider id: alias spellings collapse into the vendor, and —
 * when the caller supplies the row's model — gateway ids (zed.dev,
 * opencode, cursor, unknown) are re-attributed to the model's vendor.
 * Without model context (filter parsing, already-aggregated ids) gateway
 * ids pass through unchanged.
 */
export function canonicalProvider(raw: string, model?: string): string {
  const provider = PROVIDER_ALIASES[raw] ?? raw;
  if (model !== undefined && GATEWAY_PROVIDERS.has(provider)) {
    return inferProviderFromModel(model) ?? provider;
  }
  return provider;
}

export interface ModelMetrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  tokens: number;
  messages: number;
  cost: number;
}

const METRIC_KEYS: (keyof ModelMetrics)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "tokens",
  "messages",
  "cost",
];

/**
 * Merge aggregate rows whose ids share a canonical spelling: metrics are
 * summed, comma-separated `providers` lists unioned (canonically, with the
 * row's model as re-attribution context), and everything else keeps the
 * first row's value. `field` selects the id column (default "model") and
 * `canonicalize` the mapping (default canonicalModel); `groupBy` scopes
 * the merge for rows that carry extra dimensions (e.g. per-period
 * timeseries rows). Output preserves first-appearance order; callers
 * re-sort as their endpoint requires.
 */
export function mergeRows<T extends ModelMetrics>(
  rows: T[],
  options: {
    field?: string;
    canonicalize?: (raw: string) => string;
    groupBy?: (row: T) => string;
  } = {},
): T[] {
  const field = options.field ?? "model";
  const canonicalize = options.canonicalize ?? canonicalModel;
  // Rows merge under one canonical model, so re-canonicalizing an
  // already-canonical providers list with a sibling spelling of that model
  // is a no-op — vendor inference agrees across spellings of one model.
  const unionProviders = (model: string | undefined, ...lists: unknown[]) =>
    [
      ...new Set(
        lists
          .flatMap((list) => (typeof list === "string" ? list.split(",") : []))
          .filter((provider) => provider.length > 0)
          .map((provider) => canonicalProvider(provider, model)),
      ),
    ].join(",");
  const merged = new Map<string, T>();
  for (const row of rows) {
    const fields = row as Record<string, unknown>;
    const model = typeof fields.model === "string" ? fields.model : undefined;
    const id = canonicalize(String(fields[field] ?? ""));
    const key = (options.groupBy ? `${options.groupBy(row)}\u0000` : "") + id;
    const target = merged.get(key);
    if (!target) {
      const copy = { ...row, [field]: id };
      if (typeof fields.providers === "string") {
        (copy as Record<string, unknown>).providers = unionProviders(model, fields.providers);
      }
      merged.set(key, copy);
      continue;
    }
    for (const metric of METRIC_KEYS) target[metric] += row[metric];
    const targetFields = target as Record<string, unknown>;
    if (typeof targetFields.providers === "string" || typeof fields.providers === "string") {
      targetFields.providers = unionProviders(model, targetFields.providers, fields.providers);
    }
  }
  return [...merged.values()];
}
