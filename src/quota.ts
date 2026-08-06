/**
 * POST /api/quota — the subscription-quota snapshots behind the tokens
 * page's plan cards: how much of a plan's rate-limit window is spent,
 * when it resets, and how many manual resets are left.
 *
 * The numbers come from the vendors, but no vendor credential ever
 * leaves the machine that holds it. One collector (OracleARM, the box
 * that already runs `tokens serve`) reports each plan on its own timer:
 *
 *   Codex   `tokens codex status --json`, which reads ~/.codex/auth.json,
 *           refreshes the OAuth token if it must, and asks ChatGPT.
 *   Claude  api.anthropic.com/api/oauth/usage with the OAuth token in
 *           ~/.claude/.credentials.json, refreshed by the collector.
 *
 * This Worker sees percentages and timestamps and nothing else — which
 * also means it needs no vendor secrets of its own and no scheduled job.
 *
 * **One provider per request, stored under its own key.** The two legs
 * fail independently — an expired Claude credential must not take the
 * Codex card down with it — so each report is its own write and each
 * plan carries its own `capturedAt`. A collector that can only reach one
 * vendor still gets to say so about that one.
 *
 * Each vendor's body is its own shape and **nothing is passed through**:
 * these are third-party payloads (one of them a third-party CLI's stdout)
 * and /api/site is a contract this Worker owns. Narrowing each by hand is
 * what keeps an upstream field rename from silently becoming a homepage
 * change — and it is where the account's identity is dropped, because
 * the endpoint this feeds is public and unauthenticated.
 */

import type { Env } from "./http";
import { json, isAuthorized } from "./http";
// The payload's shape — and the KV keys it lives under — belong to the
// module that composes /api/site, so this dependency stays one-way.
import type { QuotaPlan, QuotaWindow } from "./site";
import { QUOTA_PROVIDERS, refreshSiteCache } from "./site";

function isRecord(value: unknown): value is Record<string, unknown> {
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

/** What a narrowing function returns before the plan's identity and
 *  capture time are attached. */
type Narrowed = { plan: string | null; windows: QuotaWindow[]; resetCredits: string[] };

type Narrow = (body: Record<string, unknown>) => Narrowed | string;

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
      const window = toWindow(metric.label, metric.used_percent, metric.resets_at);
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

  const plan = typeof usage.plan === "string" && usage.plan.trim() !== "" ? usage.plan.trim() : null;
  return { plan, windows, resetCredits };
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
    ["five_hour", "5h"],
    ["seven_day", "Weekly"],
  ] as const) {
    const limit = body[key];
    if (!isRecord(limit)) continue;
    const window = toWindow(label, limit.utilization, limit.resets_at);
    if (window) windows.push(window);
  }
  const plan = typeof body.plan === "string" && body.plan.trim() !== "" ? body.plan.trim() : null;
  return { plan, windows, resetCredits: [] };
};

const NARROW = new Map<string, Narrow>([
  ["codex", narrowCodex],
  ["claude", narrowClaude],
]);

/**
 * The reported provider rides in the path: `POST /api/quota/codex`. It
 * decides which vendor's shape the body is read as, and which key the
 * result overwrites.
 */
export async function handleQuota(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "Invalid API token" }, 401);
  }

  const id = new URL(request.url).pathname.slice("/api/quota/".length);
  const known = QUOTA_PROVIDERS.get(id);
  const narrow = NARROW.get(id);
  if (!known || !narrow) {
    const supported = [...QUOTA_PROVIDERS.keys()].join(", ");
    return json({ error: `Unsupported quota provider, expected one of: ${supported}` }, 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!isRecord(body)) return json({ error: "Expected a JSON object" }, 400);

  const narrowed = narrow(body);
  if (typeof narrowed === "string") return json({ error: narrowed }, 400);
  // Windows are the whole point of a snapshot, so a body without a
  // usable one is rejected rather than stored as an empty card.
  if (narrowed.windows.length === 0) {
    return json({ error: "Snapshot carries no usable rate-limit window" }, 400);
  }

  const plan: QuotaPlan = {
    ...known,
    // The server clock, never the collector's: `capturedAt` is what the
    // dashboard ages the card by, and a reporter with a skewed clock
    // could otherwise present a stale snapshot as fresh.
    capturedAt: new Date().toISOString(),
    ...narrowed,
  };

  // Storing the plan and recomposing the view is one call, so the card
  // is live by the time the collector hears "accepted" — quota is its
  // own write event, exactly like a submission.
  await refreshSiteCache(env, plan);

  return json({ success: true, provider: plan.provider, capturedAt: plan.capturedAt });
}
