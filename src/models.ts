/**
 * Canonical model names, shared by every aggregation endpoint.
 *
 * The CLIs report one id per (model x reasoning effort x serving tier):
 * `claude-fable-5-thinking-max`, `gpt-5-codex-high`, `composer-2-fast`, ...
 * For aggregate views those are all the same model, so /api/site, /api/stats,
 * /api/breakdown and /api/timeseries merge rows under a canonical name
 * (mergeModelRows / canonicalizeModelRows below). /api/graph keeps the raw
 * spellings — it is the full-fidelity export. Mechanical suffixes are
 * stripped by rule; anything the rules cannot express (Cursor's family-last
 * spellings, dated snapshots) is listed in ALIASES.
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
  // Dated snapshots of the same model.
  "kimi-k2-instruct-0905": "kimi-k2-instruct",
  "gemini-2.5-pro-exp-03-25": "gemini-2.5-pro",
  "gemini-2.5-pro-preview-05-06": "gemini-2.5-pro",
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
 * Merge aggregate rows whose model ids share a canonical name: metrics are
 * summed, comma-separated `providers` lists unioned, everything else keeps
 * the first row's value. `groupBy` scopes the merge for rows that carry
 * extra dimensions (e.g. per-period timeseries rows). Output preserves
 * first-appearance order; callers re-sort as their endpoint requires.
 */
export function mergeModelRows<T extends ModelMetrics>(
  rows: T[],
  options: { modelField?: string; groupBy?: (row: T) => string } = {},
): T[] {
  const modelField = options.modelField ?? "model";
  const merged = new Map<string, T>();
  for (const row of rows) {
    const fields = row as Record<string, unknown>;
    const model = canonicalModel(String(fields[modelField] ?? ""));
    const key = (options.groupBy ? `${options.groupBy(row)}\u0000` : "") + model;
    const target = merged.get(key);
    if (!target) {
      merged.set(key, { ...row, [modelField]: model });
      continue;
    }
    for (const metric of METRIC_KEYS) target[metric] += row[metric];
    const targetFields = target as Record<string, unknown>;
    if (typeof targetFields.providers === "string" || typeof fields.providers === "string") {
      const providers = new Set(
        [targetFields.providers, fields.providers]
          .flatMap((list) => (typeof list === "string" ? list.split(",") : []))
          .filter((provider) => provider.length > 0),
      );
      targetFields.providers = [...providers].join(",");
    }
  }
  return [...merged.values()];
}
