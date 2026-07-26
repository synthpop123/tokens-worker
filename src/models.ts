/**
 * Canonical model and provider ids, shared by every aggregation endpoint.
 *
 * The CLIs report one model id per (model x reasoning effort x serving
 * tier): `claude-fable-5-thinking-max`, `gpt-5-codex-high`,
 * `composer-2-fast`, ... For aggregate views those are all the same model,
 * so /api/site, /api/stats, /api/breakdown and /api/timeseries merge rows
 * under a canonical name (mergeRows below). Provider ids get the same
 * treatment via a small alias table (canonicalProvider): multi-provider
 * CLIs spell subscription-auth endpoints as their own providers (pi's
 * `openai-codex`), which for aggregate views are just the vendor.
 * /api/graph keeps all raw spellings — it is the full-fidelity export —
 * and raw ids remain the filter vocabulary (/api/meta, `model=` /
 * `provider=` params).
 *
 * Maintenance: when a new model shows up with a spelling the rules get
 * wrong, add an ALIASES entry. Mapping a raw name to itself pins it and
 * skips the suffix rules entirely (e.g. a model genuinely named "*-max").
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

export function canonicalProvider(raw: string): string {
  return PROVIDER_ALIASES[raw] ?? raw;
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
 * summed, comma-separated `providers` lists unioned (canonically), and
 * everything else keeps the first row's value. `field` selects the id
 * column (default "model") and `canonicalize` the mapping (default
 * canonicalModel); `groupBy` scopes the merge for rows that carry extra
 * dimensions (e.g. per-period timeseries rows). Output preserves
 * first-appearance order; callers re-sort as their endpoint requires.
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
  const unionProviders = (...lists: unknown[]) =>
    [
      ...new Set(
        lists
          .flatMap((list) => (typeof list === "string" ? list.split(",") : []))
          .filter((provider) => provider.length > 0)
          .map(canonicalProvider),
      ),
    ].join(",");
  const merged = new Map<string, T>();
  for (const row of rows) {
    const fields = row as Record<string, unknown>;
    const id = canonicalize(String(fields[field] ?? ""));
    const key = (options.groupBy ? `${options.groupBy(row)}\u0000` : "") + id;
    const target = merged.get(key);
    if (!target) {
      const copy = { ...row, [field]: id };
      if (typeof fields.providers === "string") {
        (copy as Record<string, unknown>).providers = unionProviders(fields.providers);
      }
      merged.set(key, copy);
      continue;
    }
    for (const metric of METRIC_KEYS) target[metric] += row[metric];
    const targetFields = target as Record<string, unknown>;
    if (typeof targetFields.providers === "string" || typeof fields.providers === "string") {
      targetFields.providers = unionProviders(targetFields.providers, fields.providers);
    }
  }
  return [...merged.values()];
}
