/**
 * Canonical model names for the site view (/api/site).
 *
 * The CLIs report one id per (model x reasoning effort x serving tier):
 * `claude-fable-5-thinking-max`, `gpt-5-codex-high`, `composer-2-fast`, ...
 * For the public dashboard those are all the same model, so /api/site merges
 * rows under a canonical name. Mechanical suffixes are stripped by rule;
 * anything the rules cannot express (Cursor's family-last spellings, dated
 * snapshots) is listed in ALIASES.
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
