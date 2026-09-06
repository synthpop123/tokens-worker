/**
 * POST /api/quota/:plan — the subscription-quota snapshots behind the
 * tokens page's plan cards: how much of a plan's rate-limit window is
 * spent, when it resets, and how many manual resets are left.
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
 * the endpoint this feeds is public and unauthenticated. The narrowers
 * live with the provider registry (quota-registry.ts); this module is
 * only the route around them.
 */

import type { Env } from "./http";
import { json, isAuthorized } from "./http";
import { isRecord, QUOTA_PROVIDERS, type QuotaPlan } from "./quota-registry";
import { refreshSiteCache } from "./site";

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
  if (!known) {
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

  const narrowed = known.narrow(body);
  if (typeof narrowed === "string") return json({ error: narrowed }, 400);
  // Windows are the whole point of a snapshot, so a body without a
  // usable one is rejected rather than stored as an empty card.
  if (narrowed.windows.length === 0) {
    return json({ error: "Snapshot carries no usable rate-limit window" }, 400);
  }

  const plan: QuotaPlan = {
    provider: known.provider,
    label: known.label,
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
