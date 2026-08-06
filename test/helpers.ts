/**
 * Shared plumbing for integration tests: a request helper that runs the
 * real Worker export against miniflare-backed bindings (waiting out
 * ctx.waitUntil, so KV/R2 fan-out is settled before assertions) and a
 * realistic two-day submission payload that passes the official
 * validation checks.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { SubmissionPayload } from "../src/payload";
import { QUOTA_PROVIDERS } from "../src/site";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export const AUTH = { Authorization: "Bearer test-token" };

/** Storage persists across tests within a file — start each from zero. */
export async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM daily_usage`),
    env.DB.prepare(`DELETE FROM daily_activity`),
    env.DB.prepare(`DELETE FROM devices`),
    env.DB.prepare(`DELETE FROM submissions`),
  ]);
  const objects = await env.ARCHIVE.list();
  if (objects.objects.length > 0) {
    await env.ARCHIVE.delete(objects.objects.map((object) => object.key));
  }
  await env.SITE_CACHE.delete("site");
  await Promise.all(
    [...QUOTA_PROVIDERS.values()].map(({ provider }) =>
      env.SITE_CACHE.delete(`quota:${provider}`)
    )
  );
}

export async function call(
  path: string,
  init?: RequestInit<IncomingRequestCfProperties>
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`https://tokens.test${path}`, init),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

export const DEVICE_ID = "device-test-1";
export const DEVICE_NAME = "Test MacBook";

/**
 * Two days, two clients, two spellings of the same canonical model
 * (claude-opus-4-5) so aggregation endpoints exercise id merging.
 * Totals are internally consistent: day totals match client sums and
 * the summary matches the day totals.
 */
export function submissionPayload(): SubmissionPayload {
  return {
    meta: {
      generatedAt: "2026-07-19T16:00:00Z",
      version: "3.2.1",
      dateRange: { start: "2026-07-18", end: "2026-07-19" },
    },
    device: { id: DEVICE_ID, name: DEVICE_NAME },
    summary: {
      totalTokens: 1500,
      totalCost: 0.5,
      totalDays: 2,
      activeDays: 2,
      clients: ["cursor", "claude"],
    },
    contributions: [
      {
        date: "2026-07-18",
        activeTimeMs: 3_600_000,
        totals: { tokens: 1000, cost: 0.2, messages: 6 },
        clients: [
          {
            client: "cursor",
            modelId: "claude-opus-4-5",
            providerId: "anthropic",
            tokens: { input: 400, output: 200, cacheRead: 300, cacheWrite: 50, reasoning: 50 },
            cost: 0.2,
            messages: 6,
            provenance: { schemaVersion: 3, messageCount: 6, modelCount: 1 },
          },
        ],
      },
      {
        date: "2026-07-19",
        totals: { tokens: 500, cost: 0.3, messages: 4 },
        clients: [
          {
            client: "claude",
            modelId: "claude-opus-4-5-thinking",
            providerId: "anthropic",
            tokens: { input: 200, output: 100, cacheRead: 150, cacheWrite: 30, reasoning: 20 },
            cost: 0.3,
            messages: 4,
            provenance: { schemaVersion: 3, messageCount: 4, modelCount: 1 },
          },
        ],
      },
    ],
    timeMetrics: {
      totalActiveTimeMs: 7_200_000,
      longestContinuousMs: 3_600_000,
      maxConcurrentSessions: 2,
      sessionCount: 5,
    },
    mcpServers: ["context7"],
  };
}

export function submit(payload: SubmissionPayload = submissionPayload()): Promise<Response> {
  return call("/api/submit", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * `tokens codex status --json` verbatim, down to the fields the Worker
 * is expected to drop — the email above all, which must never reach the
 * public payload. Kept whole precisely because the narrowing is the
 * contract under test.
 */
export function quotaPayload(): Record<string, unknown> {
  return {
    usage: {
      provider: "Codex",
      plan: "Team",
      email: "someone@example.com",
      metrics: [
        {
          label: "Weekly",
          used_percent: 28,
          remaining_percent: 72,
          remaining_label: null,
          resets_at: "2026-08-08T13:28:31+00:00",
        },
      ],
      reset_credits: {
        available_count: 2,
        credits: [
          {
            id: "RateLimitResetCredit_b",
            status: "available",
            reset_type: "codex_rate_limits",
            expires_at: "2026-08-12T17:51:33.326563Z",
            title: "Full reset",
            description: "Thanks for using Codex!",
          },
          {
            id: "RateLimitResetCredit_a",
            status: "available",
            reset_type: "codex_rate_limits",
            expires_at: "2026-08-11T21:08:53.949704Z",
            title: "Full reset",
            description: "Thanks for using Codex!",
          },
        ],
      },
      credit_status: { has_credits: false, unlimited: false, overage_limit_reached: false },
      spend_control: { reached: false },
    },
  };
}

/**
 * api.anthropic.com/api/oauth/usage verbatim, plus the `plan` the
 * collector reads beside the credential. The fields with no card to
 * appear on (`spend`, `extra_usage`, the parallel `limits` array) are
 * kept so the narrowing has something to drop.
 */
export function claudeQuotaPayload(): Record<string, unknown> {
  return {
    plan: "pro",
    five_hour: {
      utilization: 60,
      resets_at: "2026-08-06T11:49:59.452780+00:00",
      limit_dollars: null,
      used_dollars: null,
    },
    seven_day: {
      utilization: 6,
      resets_at: "2026-08-13T03:59:59.452807+00:00",
      limit_dollars: null,
      used_dollars: null,
    },
    seven_day_opus: null,
    limits: [
      { kind: "session", group: "session", percent: 60, severity: "normal", is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 6, severity: "normal", is_active: false },
    ],
    spend: { used: { amount_minor: 0, currency: "USD" }, percent: 0, enabled: false },
    extra_usage: { is_enabled: false, monthly_limit: null },
    member_dashboard_available: false,
  };
}

export function reportQuota(
  payload: unknown = quotaPayload(),
  provider = "codex"
): Promise<Response> {
  return call(`/api/quota/${provider}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export const reportClaudeQuota = (payload: unknown = claudeQuotaPayload()) =>
  reportQuota(payload, "claude");
