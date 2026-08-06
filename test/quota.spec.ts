/**
 * POST /api/quota — the reported subscription snapshot, and the way it
 * reaches /api/site.
 *
 * Two properties matter more than the rest. The endpoint narrows a
 * third-party CLI's output into a shape this Worker owns, so the fields
 * it is supposed to drop are asserted absent by name — the account's
 * email above all, since /api/site is public and unauthenticated. And a
 * snapshot has to survive the writes that know nothing about it: an
 * ordinary submission recomposes the payload and must carry the quota
 * card through untouched, while a full wipe must take it along.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH, call, quotaPayload, reportQuota, reset, submit } from "./helpers";

beforeEach(() => reset());

const site = async () => (await (await call("/api/site")).json()) as Record<string, any>;

describe("POST /api/quota", () => {
  it("requires the bearer token", async () => {
    const response = await call("/api/quota", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    // Rejected before the body is even read.
    expect(await env.SITE_CACHE.get("quota")).toBeNull();
  });

  it("narrows the CLI snapshot into the payload's own shape", async () => {
    const response = await reportQuota();
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, any>).toMatchObject({
      success: true,
      provider: "openai",
    });

    const { quota } = await site();
    expect(Date.parse(quota.capturedAt)).toBeTruthy();
    expect(quota.plans).toEqual([
      {
        provider: "openai",
        label: "Codex",
        plan: "Team",
        windows: [
          { label: "Weekly", usedPercent: 28, resetsAt: "2026-08-08T13:28:31.000Z" },
        ],
        // Ascending, regardless of the order the vendor listed them in.
        resetCredits: ["2026-08-11T21:08:53.949Z", "2026-08-12T17:51:33.326Z"],
      },
    ]);
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

    const { quota } = await site();
    expect(quota.plans).toHaveLength(1);
    expect(quota.plans[0].plan).toBe("Pro");
    expect(quota.plans[0].windows.map((w: any) => w.label)).toEqual(["5h", "Weekly"]);
    expect(quota.plans[0].resetCredits).toEqual([]);
  });

  it("refreshes the ETag, so a browser holding the payload sees the change", async () => {
    await submit();
    const before = (await call("/api/site")).headers.get("ETag");
    await reportQuota();
    const after = await call("/api/site");
    expect(after.headers.get("ETag")).not.toBe(before);

    const revalidated = await call("/api/site", {
      headers: { "If-None-Match": before as string },
    });
    expect(revalidated.status).toBe(200);
  });

  it.each([
    ["a non-JSON body", "not json"],
    ["a body that is not the CLI's output", JSON.stringify({ plan: "Team" })],
    ["an unknown provider", JSON.stringify({ usage: { provider: "Claude", metrics: [] } })],
    [
      "a snapshot with no usable window",
      JSON.stringify({ usage: { provider: "Codex", metrics: [{ label: "Weekly" }] } }),
    ],
  ])("rejects %s", async (_name, body) => {
    const response = await call("/api/quota", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
    expect(await env.SITE_CACHE.get("quota")).toBeNull();
  });

  it("skips a window it cannot read without losing the ones it can", async () => {
    const payload = quotaPayload();
    (payload.usage as Record<string, unknown>).metrics = [
      { label: "Monthly", used_percent: "many" },
      { label: "Weekly", used_percent: 28, resets_at: "2026-08-08T13:28:31Z" },
    ];
    expect((await reportQuota(payload)).status).toBe(200);

    const { quota } = await site();
    expect(quota.plans[0].windows).toEqual([
      { label: "Weekly", usedPercent: 28, resetsAt: "2026-08-08T13:28:31.000Z" },
    ]);
  });

  it("keeps an unparseable reset time rather than the card", async () => {
    const payload = quotaPayload();
    (payload.usage as Record<string, unknown>).metrics = [
      { label: "Weekly", used_percent: 28, resets_at: "whenever" },
    ];
    await reportQuota(payload);

    const { quota } = await site();
    expect(quota.plans[0].windows[0]).toEqual({
      label: "Weekly",
      usedPercent: 28,
      resetsAt: null,
    });
  });
});

describe("the snapshot's life beside the usage matrix", () => {
  it("is absent, not undefined, before any collector has reported", async () => {
    await submit();
    expect((await site()).quota).toBeNull();
  });

  it("survives submissions, which know nothing about it", async () => {
    await reportQuota();
    await submit();
    const { quota } = await site();
    expect(quota.plans[0].plan).toBe("Team");
  });

  it("survives a day rollover recompose", async () => {
    await reportQuota();
    // What handleSite does when the cached payload was composed on an
    // earlier calendar day: recompose inline, reading quota back from KV.
    await env.SITE_CACHE.delete("site");
    expect((await site()).quota.plans[0].plan).toBe("Team");
  });

  it("is deleted by the full wipe — it names the account's plan", async () => {
    await submit();
    await reportQuota();
    const response = await call("/api/settings/submitted-data", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(response.status).toBe(200);
    expect(await env.SITE_CACHE.get("quota")).toBeNull();
    expect((await site()).quota).toBeNull();
  });
});
