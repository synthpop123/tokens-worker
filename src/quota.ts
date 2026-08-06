/**
 * POST /api/quota — the subscription-quota snapshot behind the tokens
 * page's plan card: how much of the plan's rate-limit window is spent,
 * when it resets, and how many manual resets are left.
 *
 * The number comes from the vendor, but the credential never leaves the
 * machine that holds it. One collector (OracleARM, the box that already
 * runs `tokens serve`) shells out to `tokens codex status --json` every
 * 30 minutes and POSTs the result here; that command reads the local
 * ~/.codex/auth.json, refreshes the OAuth token if it has to, and asks
 * ChatGPT's usage API. This Worker sees percentages and timestamps and
 * nothing else — a design that also means it needs no vendor secrets of
 * its own, and no scheduled job to go stale.
 *
 * The body is that command's output verbatim, so **nothing here is
 * passed through**. The CLI is a third-party binary (missuo/tokens) that
 * owns its own output shape; /api/site is a versioned contract this
 * Worker owns. Narrowing the one into the other by hand is what keeps an
 * upstream field rename from silently becoming a homepage change — and
 * it is where the account's email address gets dropped, because the
 * endpoint this feeds is public and unauthenticated.
 */

import type { Env } from "./http";
import { json, isAuthorized } from "./http";
// The payload's shape — and the KV key it lives under — belong to the
// module that composes /api/site, so this dependency stays one-way.
import type { QuotaPlan, QuotaSnapshot, QuotaWindow } from "./site";
import { refreshSiteCache } from "./site";

/**
 * Accepted subscriptions, keyed by the CLI's `provider` string folded to
 * lowercase — a Map, not an object, because the key comes straight from
 * the request body and a plain object would answer `constructor` with an
 * inherited function. `provider` is the canonical vendor id used
 * everywhere else in the payload; `label` is what the plan calls itself.
 */
const PROVIDERS = new Map<string, { provider: string; label: string }>([
  ["codex", { provider: "openai", label: "Codex" }],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Any parseable instant in, ISO-8601 UTC out; anything else is null.
 *  The CLI reports offsets ("+00:00") and sub-second precision, and the
 *  payload should read the same whichever it sent. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type Narrowed = { plan: QuotaPlan } | { error: string };

function narrowPlan(body: unknown): Narrowed {
  if (!isRecord(body) || !isRecord(body.usage)) {
    return { error: "Expected `tokens <provider> status --json` output: {usage: {...}}" };
  }
  const usage = body.usage;

  const known =
    typeof usage.provider === "string" ? PROVIDERS.get(usage.provider.toLowerCase()) : undefined;
  if (!known) return { error: `Unsupported quota provider: ${JSON.stringify(usage.provider)}` };

  // Windows are the whole point of the snapshot, so a body without a
  // usable one is rejected rather than stored as an empty card. Malformed
  // *individual* windows are skipped: a future CLI reporting a third
  // window in a shape this does not understand should cost that window,
  // not the reading.
  const windows: QuotaWindow[] = [];
  if (Array.isArray(usage.metrics)) {
    for (const metric of usage.metrics) {
      if (!isRecord(metric)) continue;
      const { label, used_percent: used } = metric;
      if (typeof label !== "string" || label === "") continue;
      if (typeof used !== "number" || !Number.isFinite(used)) continue;
      windows.push({
        label,
        usedPercent: Math.min(100, Math.max(0, used)),
        resetsAt: isoOrNull(metric.resets_at),
      });
    }
  }
  if (windows.length === 0) {
    return { error: "Snapshot carries no usable rate-limit window" };
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

  const plan = typeof usage.plan === "string" && usage.plan.trim() !== "" ? usage.plan.trim() : null;

  return { plan: { ...known, plan, windows, resetCredits } };
}

export async function handleQuota(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Invalid API token" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const narrowed = narrowPlan(body);
  if ("error" in narrowed) return json({ error: narrowed.error }, 400);

  // The server clock, never the collector's: `capturedAt` is what the
  // dashboard ages the card by, and a reporter with a skewed clock could
  // otherwise present a stale snapshot as fresh.
  const snapshot: QuotaSnapshot = {
    capturedAt: new Date().toISOString(),
    plans: [narrowed.plan],
  };

  // Storing the snapshot and recomposing the view is one call, so the
  // card is live by the time the collector hears "accepted" — quota is
  // its own write event, exactly like a submission.
  await refreshSiteCache(env, snapshot);

  return json({ success: true, capturedAt: snapshot.capturedAt, provider: narrowed.plan.provider });
}
