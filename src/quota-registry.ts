/**
 * The subscription quota registry: what a reported plan looks like, and
 * one entry per provider this Worker will store — its canonical vendor
 * id, its display label, and the hand-written narrowing of that vendor's
 * body. Routing (quota.ts) and composition (site.ts) both read it, which
 * is why it is its own module rather than a corner of either: a provider
 * is added in exactly one place.
 *
 * The narrowers are deliberately not generic. An upstream field rename
 * must become a 400 here, never a silent contract change downstream —
 * and this is also where account identity (emails, credit status) is
 * dropped, since /api/site is public.
 */

/** One surface's share of a window's spend ("Claude Code", 80). */
export interface QuotaShare {
  label: string;
  percent: number;
}

/** One rate-limit window of a plan — Codex Team has just the weekly one,
 *  Claude Pro reports a 5-hour window beside it, so this is a list. */
export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  /** Where the window's spend went, by surface, largest first. Only
   *  shares above zero; empty when the vendor does not say (Codex never
   *  does, Claude only for the weekly window). */
  breakdown: QuotaShare[];
}

/** A dollar-denominated allowance beside the percentage windows —
 *  Claude's cloud session credits. Dollars, because that is the unit the
 *  vendor meters it in and a percentage would hide the size of it. */
export interface QuotaAllowance {
  label: string;
  usedDollars: number;
  limitDollars: number;
  resetsAt: string | null;
}

/** A banked manual reset: when it lapses, and what spending it does
 *  ("Full reset (Weekly + 5 hr)") when the vendor says. */
export interface QuotaCredit {
  expiresAt: string;
  title: string | null;
}

/** Pay-as-you-go usage past the plan's ceilings. `used`/`limit` are in
 *  `currency`'s major unit, null when the vendor does not report them
 *  (Codex reports only whether credits exist). */
export interface QuotaExtraUsage {
  enabled: boolean;
  used: number | null;
  limit: number | null;
  currency: string | null;
}

export interface QuotaPlan {
  /** Canonical vendor id, so the dashboard can reuse its provider marks. */
  provider: string;
  label: string;
  plan: string | null;
  /** Server clock at the moment this plan was reported. Per plan, not
   *  per payload: two collectors on their own timers are two different
   *  answers to "how old is this", and one of them can be hours stale
   *  while the other is a minute old. */
  capturedAt: string;
  windows: QuotaWindow[];
  /** Dollar allowances, in the vendor's order. Empty when none. */
  allowances: QuotaAllowance[];
  /** Each unspent manual-reset credit, soonest expiry first. The count
   *  is the list's length; storing both would be one number too many.
   *  Empty for plans with no such thing (Claude has none). */
  resetCredits: QuotaCredit[];
  /** Null when the vendor's body says nothing about it. */
  extraUsage: QuotaExtraUsage | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Any parseable instant in, ISO-8601 UTC out; anything else is null.
 *  The vendors report offsets ("+00:00") and sub-second precision, and
 *  the payload should read the same whichever it sent. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function toWindow(
  label: string,
  used: unknown,
  resetsAt: unknown,
  breakdown: QuotaShare[] = []
): QuotaWindow | null {
  if (!isNumber(used)) return null;
  return {
    label,
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAt: isoOrNull(resetsAt),
    breakdown,
  };
}

/**
 * A subscription tier as the payload publishes it. The vendors disagree
 * about case — the Codex CLI capitalizes ("Team"), Anthropic stores the
 * raw enum ("pro") — and two cards side by side should not advertise
 * that. Only the first letter is touched: "Pro", "Max", "Team", and
 * anything a vendor deliberately cased stays as it came.
 */
function tierOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tier = value.trim();
  return tier === "" ? null : tier[0].toUpperCase() + tier.slice(1);
}

/** What a narrowing function returns before the plan's identity and
 *  capture time are attached. */
type Narrowed = Omit<QuotaPlan, "provider" | "label" | "capturedAt">;

type Narrow = (body: Record<string, unknown>) => Narrowed | string;

/** The CLI prints the window's length ("5h") where Anthropic names the
 *  session; two cards side by side should agree. An unlisted label is
 *  published as it came. */
const CODEX_LABELS = new Map([["5h", "Session"]]);

/**
 * `tokens codex status --json` — `{usage: {plan, metrics: [...], ...}}`.
 * Its `email` is dropped — identity — as are the credits' ids and
 * marketing copy. `credit_status` survives only as whether usage past
 * the limits is possible at all: it carries no balance to show.
 */
const narrowCodex: Narrow = (body) => {
  if (!isRecord(body.usage)) return "Expected `tokens codex status --json` output: {usage: {…}}";
  const usage = body.usage;

  // Malformed *individual* windows are skipped rather than fatal: a
  // future CLI reporting a third window in a shape this does not
  // understand should cost that window, not the whole reading.
  const windows: QuotaWindow[] = [];
  if (Array.isArray(usage.metrics)) {
    for (const metric of usage.metrics) {
      if (!isRecord(metric) || typeof metric.label !== "string" || metric.label === "") continue;
      const label = CODEX_LABELS.get(metric.label) ?? metric.label;
      const window = toWindow(label, metric.used_percent, metric.resets_at);
      if (window) windows.push(window);
    }
  }

  // Only unspent credits: a redeemed one is history, and the card counts
  // what is still available to spend.
  const resetCredits: QuotaCredit[] = [];
  const credits = isRecord(usage.reset_credits) ? usage.reset_credits.credits : undefined;
  if (Array.isArray(credits)) {
    for (const credit of credits) {
      if (!isRecord(credit) || credit.status !== "available") continue;
      const expiresAt = isoOrNull(credit.expires_at);
      if (expiresAt !== null) resetCredits.push({ expiresAt, title: textOrNull(credit.title) });
    }
  }
  resetCredits.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

  const status = usage.credit_status;
  const extraUsage: QuotaExtraUsage | null = isRecord(status)
    ? {
        enabled: status.has_credits === true || status.unlimited === true,
        used: null,
        limit: null,
        currency: null,
      }
    : null;

  return { plan: tierOf(usage.plan), windows, allowances: [], resetCredits, extraUsage };
};

/** Anthropic's named windows, in card order. The model- and
 *  surface-scoped weekly ceilings are null on plans without them and
 *  only appear on the card when the vendor reports one. */
const CLAUDE_WINDOWS = [
  ["five_hour", "Session"],
  ["seven_day", "Weekly"],
  ["seven_day_opus", "Weekly · Opus"],
  ["seven_day_sonnet", "Weekly · Sonnet"],
  ["seven_day_cowork", "Weekly · Cowork"],
] as const;

/** Anthropic's dollar allowances sit under codenames; only the ones
 *  whose meaning is known are published, under the name the product
 *  gives them. An unknown codename is skipped, not guessed at. */
const CLAUDE_ALLOWANCES = [["iguana_necktie", "Cloud session credits"]] as const;

/** `seven_day_breakdown.rows` — each surface's share of the weekly spend. */
function sharesOf(value: unknown): QuotaShare[] {
  if (!isRecord(value) || !Array.isArray(value.rows)) return [];
  const shares: QuotaShare[] = [];
  for (const row of value.rows) {
    if (!isRecord(row) || !isNumber(row.percent) || row.percent <= 0) continue;
    const label = textOrNull(row.display_name) ?? textOrNull(row.key);
    if (label) shares.push({ label, percent: Math.min(100, row.percent) });
  }
  return shares.sort((a, b) => b.percent - a.percent);
}

/** `{amount_minor, exponent}` → the major unit; anything else is null. */
function moneyOf(value: unknown): number | null {
  if (!isRecord(value) || !isNumber(value.amount_minor)) return null;
  const exponent = isNumber(value.exponent) ? value.exponent : 2;
  return value.amount_minor / 10 ** exponent;
}

/**
 * api.anthropic.com/api/oauth/usage — `{five_hour, seven_day, limits,
 * spend, …}`. The named windows are read rather than the parallel
 * `limits` array, which says the same thing through an open-ended `kind`
 * enum. Claude has no manual-reset credits, so that list is always
 * empty; the plan tier is not in this response, so the collector sends
 * the `subscriptionType` it read beside the credential.
 */
const narrowClaude: Narrow = (body) => {
  const windows: QuotaWindow[] = [];
  for (const [key, label] of CLAUDE_WINDOWS) {
    const limit = body[key];
    if (!isRecord(limit)) continue;
    const shares = key === "seven_day" ? sharesOf(body.seven_day_breakdown) : [];
    const window = toWindow(label, limit.utilization, limit.resets_at, shares);
    if (window) windows.push(window);
  }

  const allowances: QuotaAllowance[] = [];
  for (const [key, label] of CLAUDE_ALLOWANCES) {
    const allowance = body[key];
    if (!isRecord(allowance) || !isNumber(allowance.limit_dollars)) continue;
    if (allowance.limit_dollars <= 0) continue;
    allowances.push({
      label,
      usedDollars: isNumber(allowance.used_dollars) ? Math.max(0, allowance.used_dollars) : 0,
      limitDollars: allowance.limit_dollars,
      resetsAt: isoOrNull(allowance.resets_at),
    });
  }

  // `spend` is the one with minor units and an explicit currency; the
  // parallel `extra_usage` block says the same through looser fields.
  const spend = body.spend;
  const extraUsage: QuotaExtraUsage | null =
    isRecord(spend) && typeof spend.enabled === "boolean"
      ? {
          enabled: spend.enabled,
          used: moneyOf(spend.used),
          limit: moneyOf(spend.limit) ?? moneyOf(spend.cap),
          currency: isRecord(spend.used) ? textOrNull(spend.used.currency) : null,
        }
      : null;

  return { plan: tierOf(body.plan), windows, allowances, resetCredits: [], extraUsage };
};

/**
 * Keyed by the id a collector reports in the path (`/api/quota/codex`).
 * A Map, not an object: the key comes from a request. `provider` is the
 * canonical vendor id used everywhere else in the payload (so the
 * dashboard reuses its brand marks), and `label` is what the
 * subscription calls itself — "Codex" is a plan, not a vendor.
 */
export const QUOTA_PROVIDERS = new Map<string, { provider: string; label: string; narrow: Narrow }>([
  ["codex", { provider: "openai", label: "Codex", narrow: narrowCodex }],
  ["claude", { provider: "anthropic", label: "Claude", narrow: narrowClaude }],
]);
