/**
 * POST /api/quota/:provider — the reported subscription snapshots, and
 * the way they reach /api/site.
 *
 * Three properties carry this endpoint. Each vendor's body is narrowed
 * into a shape this Worker owns, so the fields it is supposed to drop
 * are asserted absent by name — account identity above all, since
 * /api/site is public and unauthenticated. The two plans are stored
 * under their own keys, so one collector failing must not disturb the
 * other's card. And a plan has to survive the writes that know nothing
 * about it: an ordinary submission recomposes the payload and must carry
 * every card through, while a full wipe takes them all.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH,
  call,
  claudeQuotaPayload,
  quotaPayload,
  reportClaudeQuota,
  reportQuota,
  reset,
  submit,
} from "./helpers";

beforeEach(() => reset());

const site = async () => (await (await call("/api/site")).json()) as Record<string, any>;
const planOf = async (provider: string) =>
  (await site()).quota.find((plan: any) => plan.provider === provider);

describe("POST /api/quota/codex", () => {
  it("requires the bearer token", async () => {
    const response = await call("/api/quota/codex", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    // Rejected before the body is even read.
    expect(await env.SITE_CACHE.get("quota:openai")).toBeNull();
  });

  it("narrows the CLI snapshot into the payload's own shape", async () => {
    const response = await reportQuota();
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, any>).toMatchObject({
      success: true,
      provider: "openai",
    });

    const plan = await planOf("openai");
    expect(Date.parse(plan.capturedAt)).toBeTruthy();
    expect(plan).toMatchObject({
      provider: "openai",
      label: "Codex",
      plan: "Team",
      windows: [{ label: "Weekly", usedPercent: 28, resetsAt: "2026-08-08T13:28:31.000Z" }],
      // Ascending, regardless of the order the vendor listed them in.
      resetCredits: ["2026-08-11T21:08:53.949Z", "2026-08-12T17:51:33.326Z"],
    });
  });

  it("never leaks the account identity into the public payload", async () => {
    await reportQuota();
    const body = await (await call("/api/site")).text();
    expect(body).not.toContain("someone@example.com");
    expect(body).not.toContain("RateLimitResetCredit_a");
    // Fields with no card to appear on are dropped whole, not carried
    // "just in case" — the payload is a view, not a mirror.
    for (const key of ["email", "credit_status", "spend_control", "remaining_percent"]) {
      expect(body, key).not.toContain(key);
    }
  });

  it("is a full overwrite, so a plan change cannot leave a stale window", async () => {
    await reportQuota();
    const next = quotaPayload();
    (next.usage as Record<string, unknown>).plan = "Pro";
    (next.usage as Record<string, unknown>).metrics = [
      { label: "5h", used_percent: 4, resets_at: "2026-08-06T18:00:00Z" },
      { label: "Weekly", used_percent: 61, resets_at: "2026-08-08T13:28:31Z" },
    ];
    (next.usage as Record<string, unknown>).reset_credits = { available_count: 0, credits: [] };
    await reportQuota(next);

    const plan = await planOf("openai");
    expect((await site()).quota).toHaveLength(1);
    expect(plan.plan).toBe("Pro");
    expect(plan.windows.map((w: any) => w.label)).toEqual(["5h", "Weekly"]);
    expect(plan.resetCredits).toEqual([]);
  });

  it("skips a window it cannot read without losing the ones it can", async () => {
    const payload = quotaPayload();
    (payload.usage as Record<string, unknown>).metrics = [
      { label: "Monthly", used_percent: "many" },
      { label: "Weekly", used_percent: 28, resets_at: "2026-08-08T13:28:31Z" },
    ];
    expect((await reportQuota(payload)).status).toBe(200);
    expect((await planOf("openai")).windows).toEqual([
      { label: "Weekly", usedPercent: 28, resetsAt: "2026-08-08T13:28:31.000Z" },
    ]);
  });

  it("keeps an unparseable reset time rather than the card", async () => {
    const payload = quotaPayload();
    (payload.usage as Record<string, unknown>).metrics = [
      { label: "Weekly", used_percent: 28, resets_at: "whenever" },
    ];
    await reportQuota(payload);
    expect((await planOf("openai")).windows[0]).toEqual({
      label: "Weekly",
      usedPercent: 28,
      resetsAt: null,
    });
  });
});

describe("POST /api/quota/claude", () => {
  it("narrows the Anthropic usage response", async () => {
    const response = await reportClaudeQuota();
    expect(response.status).toBe(200);

    const plan = await planOf("anthropic");
    expect(plan).toMatchObject({
      provider: "anthropic",
      label: "Claude",
      // Anthropic stores the raw enum ("pro"); the payload publishes
      // one casing so two cards side by side do not advertise the
      // vendors' disagreement.
      plan: "Pro",
      windows: [
        { label: "Session", usedPercent: 60, resetsAt: "2026-08-06T11:49:59.452Z" },
        { label: "Weekly", usedPercent: 6, resetsAt: "2026-08-13T03:59:59.452Z" },
      ],
      // Claude has no manual-reset credits; the list is empty, not absent.
      resetCredits: [],
    });
  });

  it("drops the vendor fields that have no card", async () => {
    await reportClaudeQuota();
    const body = await (await call("/api/site")).text();
    for (const key of ["limit_dollars", "spend", "extra_usage", "member_dashboard", "severity"]) {
      expect(body, key).not.toContain(key);
    }
  });

  it("reads the named windows, not the open-ended limits array", async () => {
    // A vendor that renames a `kind` must not silently change the card:
    // the array is decoration here, and dropping it changes nothing.
    const payload = claudeQuotaPayload();
    payload.limits = [{ kind: "something_new", percent: 99 }];
    await reportClaudeQuota(payload);
    const plan = await planOf("anthropic");
    expect(plan.windows.map((w: any) => w.usedPercent)).toEqual([60, 6]);
  });

  it("keeps a plan reporting only one of its windows", async () => {
    const payload = claudeQuotaPayload();
    payload.five_hour = null;
    await reportClaudeQuota(payload);
    expect((await planOf("anthropic")).windows).toEqual([
      { label: "Weekly", usedPercent: 6, resetsAt: "2026-08-13T03:59:59.452Z" },
    ]);
  });
});

describe("the two collectors are independent", () => {
  it("keeps both plans, in provider order", async () => {
    await reportClaudeQuota();
    await reportQuota();
    const { quota } = await site();
    expect(quota.map((plan: any) => plan.provider)).toEqual(["openai", "anthropic"]);
  });

  it("lets one leg go stale without disturbing the other", async () => {
    await reportQuota();
    await reportClaudeQuota();
    const before = await planOf("openai");

    // Claude reports again; Codex's card must be untouched, including
    // the capture time it is aged by.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await reportClaudeQuota();
    const after = await planOf("openai");
    expect(after).toEqual(before);
    expect((await planOf("anthropic")).capturedAt).not.toBe(before.capturedAt);
  });

  it("rejects a body one vendor's shape cannot read, leaving the other alone", async () => {
    await reportQuota();
    // The Anthropic response shape, posted to the Codex route.
    const response = await reportQuota(claudeQuotaPayload(), "codex");
    expect(response.status).toBe(400);
    expect(await planOf("anthropic")).toBeUndefined();
    expect((await planOf("openai")).plan).toBe("Team");
  });

  it("404s an unknown provider rather than storing it", async () => {
    const response = await reportQuota(quotaPayload(), "gemini");
    expect(response.status).toBe(404);
    expect((await site()).quota).toEqual([]);
  });
});

describe("rejections", () => {
  it.each([
    ["a non-JSON body", "codex", "not json"],
    ["a body that is not the CLI's output", "codex", JSON.stringify({ plan: "Team" })],
    [
      "a snapshot with no usable window",
      "codex",
      JSON.stringify({ usage: { metrics: [{ label: "Weekly" }] } }),
    ],
    ["an Anthropic body with no windows", "claude", JSON.stringify({ plan: "pro" })],
    ["a JSON array", "claude", JSON.stringify([1, 2])],
  ])("rejects %s", async (_name, provider, body) => {
    const response = await call(`/api/quota/${provider}`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
    expect((await site()).quota).toEqual([]);
  });
});

describe("a plan's life beside the usage matrix", () => {
  it("is an empty list, not null, before any collector has reported", async () => {
    await submit();
    expect((await site()).quota).toEqual([]);
  });

  it("survives submissions, which know nothing about it", async () => {
    await reportQuota();
    await reportClaudeQuota();
    await submit();
    expect((await site()).quota).toHaveLength(2);
  });

  it("survives a day rollover recompose", async () => {
    await reportQuota();
    // What handleSite does when the cached payload was composed on an
    // earlier calendar day: recompose inline, reading quota back from KV.
    await env.SITE_CACHE.delete("site");
    expect((await planOf("openai")).plan).toBe("Team");
  });

  it("refreshes the ETag, so a browser holding the payload sees the change", async () => {
    await submit();
    const before = (await call("/api/site")).headers.get("ETag");
    await reportQuota();
    expect((await call("/api/site")).headers.get("ETag")).not.toBe(before);
  });

  it("is deleted by the full wipe — it names the account's subscription", async () => {
    await submit();
    await reportQuota();
    await reportClaudeQuota();
    const response = await call("/api/settings/submitted-data", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(response.status).toBe(200);
    expect(await env.SITE_CACHE.get("quota:openai")).toBeNull();
    expect(await env.SITE_CACHE.get("quota:anthropic")).toBeNull();
    expect((await site()).quota).toEqual([]);
  });
});
