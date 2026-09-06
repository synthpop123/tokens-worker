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

/** One rate-limit window of a plan — Codex Team has just the weekly one,
 *  Claude Pro reports a 5-hour window beside it, so this is a list. */
export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
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
  /** Expiry of each unspent manual-reset credit, ascending. The count is
   *  the list's length; storing both would be one number too many.
   *  Empty for plans with no such thing (Claude has none). */
  resetCredits: string[];
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

function toWindow(label: string, used: unknown, resetsAt: unknown): QuotaWindow | null {
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return {
    label,
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAt: isoOrNull(resetsAt),
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
type Narrowed = { plan: string | null; windows: QuotaWindow[]; resetCredits: string[] };

type Narrow = (body: Record<string, unknown>) => Narrowed | string;

/** The CLI prints the window's length ("5h") where Anthropic names the
 *  session; two cards side by side should agree. An unlisted label is
 *  published as it came. */
const CODEX_LABELS = new Map([["5h", "Session"]]);

/**
 * `tokens codex status --json` — `{usage: {plan, metrics: [...], ...}}`.
 * Its `email` and `credit_status` are dropped: one is identity, the
 * other has no card to appear on.
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
  const resetCredits: string[] = [];
  const credits = isRecord(usage.reset_credits) ? usage.reset_credits.credits : undefined;
  if (Array.isArray(credits)) {
    for (const credit of credits) {
      if (!isRecord(credit) || credit.status !== "available") continue;
      const expiresAt = isoOrNull(credit.expires_at);
      if (expiresAt !== null) resetCredits.push(expiresAt);
    }
  }
  resetCredits.sort();

  return { plan: tierOf(usage.plan), windows, resetCredits };
};

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
  for (const [key, label] of [
    ["five_hour", "Session"],
    ["seven_day", "Weekly"],
  ] as const) {
    const limit = body[key];
    if (!isRecord(limit)) continue;
    const window = toWindow(label, limit.utilization, limit.resets_at);
    if (window) windows.push(window);
  }
  return { plan: tierOf(body.plan), windows, resetCredits: [] };
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
