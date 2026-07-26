/**
 * Submission payload types and validation, mirroring the official server
 * (web/src/lib/validation/submission.ts in missuo/tokens; formerly
 * packages/frontend/src/lib/validation/submission.ts before the v27 rebuild).
 *
 * Deviations from the official zod schema, chosen for a single-user
 * self-hosted backend running current (v3+) CLIs only:
 *   - Unknown client ids are accepted instead of rejected, so a newer CLI
 *     keeps working without a Worker redeploy.
 *   - Provenance schemaVersion caps are not enforced; revision floors
 *     (see merge.ts) still guarantee comparability.
 *   - Pre-v2 payload shapes are not supported: no "sources"/"source" key
 *     renames and no per-day timestampMs (the current CLI sends neither).
 */

import { DATE_RE } from "./http";

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface Provenance {
  schemaVersion: number;
  messageCount: number;
  modelCount: number;
}

export interface ClientContribution {
  client: string;
  modelId: string;
  providerId?: string;
  tokens: TokenBreakdown;
  cost: number;
  messages: number;
  provenance?: Provenance;
}

export interface DailyContribution {
  date: string;
  activeTimeMs?: number;
  totals: { tokens: number; cost: number; messages: number };
  intensity?: number;
  tokenBreakdown?: TokenBreakdown;
  clients: ClientContribution[];
}

export interface ManifestCoverage {
  mode: string;
  start: string;
  end: string;
  missingData?: string;
}

export interface ManifestEntry {
  client: string;
  parserRevision: number;
  coverage?: ManifestCoverage;
}

export interface SubmissionPayload {
  meta?: {
    generatedAt?: string;
    version?: string;
    dateRange?: { start?: string; end?: string };
  };
  device?: { id?: string; name?: string };
  summary?: {
    totalTokens?: number;
    totalCost?: number;
    totalDays?: number;
    activeDays?: number;
    averagePerDay?: number;
    maxCostInSingleDay?: number;
    clients?: string[];
    models?: string[];
  };
  years?: Array<{ year?: string; totalTokens?: number; totalCost?: number }>;
  contributions?: DailyContribution[];
  timeMetrics?: {
    totalActiveTimeMs?: number;
    longestContinuousMs?: number;
    maxConcurrentSessions?: number;
    sessionCount?: number;
  };
  mcpServers?: string[];
  clientManifest?: { schemaVersion?: number; clients?: ManifestEntry[] };
}

export const LEGACY_DEVICE_KEY = "legacy-default";
export const LEGACY_DEVICE_NAME = "Legacy submissions";

const LEGACY_CLIENT_ALIASES: Record<string, string> = { kilocode: "kilo" };

// Official validation tolerances.
const COST_REL_TOL = 0.01;
const COST_ABS_TOL = 0.1;
const TOKEN_REL_TOL = 0.01;
const TOKEN_ABS_TOL = 100;
const LEGACY_COST_EPSILON = 1e-6;

/** Cursor legacy premium-tool-call rows carry cost without tokens. */
const CURSOR_LEGACY_TOKENLESS_MODELS = new Set(["premium-tool-call"]);

export function tokenTotal(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}

export function asNonNegativeInt(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : 0;
}

export function asNonNegativeNumber(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return n >= 0 ? n : 0;
}

function aliasClient(id: unknown): unknown {
  if (typeof id === "string" && id in LEGACY_CLIENT_ALIASES) return LEGACY_CLIENT_ALIASES[id];
  return id;
}

/**
 * kilocode→kilo alias and empty modelId→"unknown", as in the official
 * normalization. Mutates in place.
 */
export function normalizePayload(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const d = raw as Record<string, unknown>;

  if (d.summary && typeof d.summary === "object") {
    const summary = d.summary as Record<string, unknown>;
    if (Array.isArray(summary.clients)) summary.clients = summary.clients.map(aliasClient);
  }

  if (Array.isArray(d.contributions)) {
    for (const c of d.contributions) {
      if (!c || typeof c !== "object") continue;
      const day = c as Record<string, unknown>;
      if (!Array.isArray(day.clients)) continue;
      for (const entry of day.clients) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        row.client = aliasClient(row.client);
        if (typeof row.modelId !== "string" || row.modelId.trim() === "") {
          row.modelId = "unknown";
        } else {
          row.modelId = row.modelId.trim();
        }
      }
    }
  }

  if (d.clientManifest && typeof d.clientManifest === "object") {
    const manifest = d.clientManifest as Record<string, unknown>;
    if (Array.isArray(manifest.clients)) {
      for (const entry of manifest.clients) {
        if (entry && typeof entry === "object" && "client" in entry) {
          (entry as Record<string, unknown>).client = aliasClient(
            (entry as Record<string, unknown>).client
          );
        }
      }
    }
  }
}

function exceedsTolerance(actual: number, expected: number, relTol: number, absTol: number): boolean {
  const diff = Math.abs(actual - expected);
  return diff > Math.abs(expected) * relTol && diff > absTol;
}

function isLegacyTokenlessCursorClient(c: ClientContribution): boolean {
  return (
    c.client === "cursor" &&
    CURSOR_LEGACY_TOKENLESS_MODELS.has(c.modelId) &&
    tokenTotal(c.tokens) === 0
  );
}

function coerceBreakdown(raw: unknown): TokenBreakdown {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    input: asNonNegativeInt(t.input),
    output: asNonNegativeInt(t.output),
    cacheRead: asNonNegativeInt(t.cacheRead),
    cacheWrite: asNonNegativeInt(t.cacheWrite),
    reasoning: asNonNegativeInt(t.reasoning),
  };
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Structural coercion + the official mathematical-consistency checks.
 * Mutates the payload into fully-coerced form (numbers clamped, breakdowns
 * filled in) so downstream merge code can trust the shapes.
 */
export function validatePayload(payload: SubmissionPayload): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(payload.contributions)) {
    errors.push("contributions must be an array");
    return { errors, warnings };
  }

  // No future dates beyond +2 days (timezone/clock-skew allowance, official).
  const maxDateStr = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const seenDates = new Set<string>();
  for (const day of payload.contributions) {
    if (!day || typeof day !== "object" || typeof day.date !== "string" || !DATE_RE.test(day.date)) {
      errors.push(`Invalid contribution date: ${JSON.stringify((day as DailyContribution | null)?.date)}`);
      continue;
    }
    if (seenDates.has(day.date)) errors.push(`Duplicate date found: ${day.date}`);
    seenDates.add(day.date);
    if (day.date > maxDateStr) errors.push(`Future date found in contributions: ${day.date}`);

    if (!Array.isArray(day.clients)) day.clients = [];
    const coercedClients: ClientContribution[] = [];
    for (const c of day.clients) {
      if (!c || typeof c !== "object" || typeof c.client !== "string" || c.client.trim() === "") {
        errors.push(`Day ${day.date}: malformed client row`);
        continue;
      }
      const row: ClientContribution = {
        client: c.client,
        modelId: typeof c.modelId === "string" && c.modelId !== "" ? c.modelId : "unknown",
        providerId: typeof c.providerId === "string" ? c.providerId : undefined,
        tokens: coerceBreakdown(c.tokens),
        cost: asNonNegativeNumber(c.cost),
        messages: asNonNegativeInt(c.messages),
        provenance: c.provenance
          ? {
              schemaVersion: Math.max(1, asNonNegativeInt(c.provenance.schemaVersion)),
              messageCount: asNonNegativeInt(c.provenance.messageCount),
              modelCount: asNonNegativeInt(c.provenance.modelCount),
            }
          : undefined,
      };
      coercedClients.push(row);
    }
    day.clients = coercedClients;

    const totals = (day.totals ?? {}) as { tokens?: number; cost?: number; messages?: number };
    day.totals = {
      tokens: asNonNegativeInt(totals.tokens),
      cost: asNonNegativeNumber(totals.cost),
      messages: asNonNegativeInt(totals.messages),
    };

    // Day-level consistency (official: errors, not warnings).
    if (day.tokenBreakdown) {
      day.tokenBreakdown = coerceBreakdown(day.tokenBreakdown);
      const breakdownTokens = tokenTotal(day.tokenBreakdown);
      if (exceedsTolerance(breakdownTokens, day.totals.tokens, TOKEN_REL_TOL, TOKEN_ABS_TOL)) {
        errors.push(
          `Day ${day.date}: token breakdown (${breakdownTokens}) does not match total (${day.totals.tokens})`
        );
      }
    }

    if (day.clients.length > 0) {
      const clientTokens = day.clients.reduce((s, c) => s + tokenTotal(c.tokens), 0);
      const clientCost = day.clients.reduce((s, c) => s + c.cost, 0);
      if (exceedsTolerance(clientTokens, day.totals.tokens, TOKEN_REL_TOL, TOKEN_ABS_TOL)) {
        errors.push(
          `Day ${day.date}: client tokens (${clientTokens}) do not match total (${day.totals.tokens})`
        );
      }
      if (exceedsTolerance(clientCost, day.totals.cost, COST_REL_TOL, COST_ABS_TOL)) {
        errors.push(
          `Day ${day.date}: client cost (${clientCost.toFixed(2)}) does not match total (${day.totals.cost.toFixed(2)})`
        );
      }
    }

    // Cost-without-tokens guard with the Cursor premium-tool-call carve-out.
    if (day.totals.cost > 0 && day.totals.tokens === 0) {
      const legacyCost = day.clients
        .filter(isLegacyTokenlessCursorClient)
        .reduce((s, c) => s + c.cost, 0);
      if (Math.max(0, day.totals.cost - legacyCost) > LEGACY_COST_EPSILON) {
        errors.push(`Day ${day.date}: Cost submitted without tokens`);
      }
    }
    for (const c of day.clients) {
      if (c.cost > 0 && tokenTotal(c.tokens) === 0 && !isLegacyTokenlessCursorClient(c)) {
        errors.push(
          `Client ${c.client}/${c.modelId} on ${day.date}: Cost submitted without tokens`
        );
      }
    }
  }

  // Summary-level consistency.
  const summary = payload.summary;
  if (summary) {
    summary.totalTokens = asNonNegativeInt(summary.totalTokens);
    summary.totalCost = asNonNegativeNumber(summary.totalCost);
    summary.activeDays = asNonNegativeInt(summary.activeDays);

    const calcTokens = payload.contributions.reduce((s, d) => s + (d.totals?.tokens ?? 0), 0);
    const calcCost = payload.contributions.reduce((s, d) => s + (d.totals?.cost ?? 0), 0);
    const tokenDiff = Math.abs(calcTokens - summary.totalTokens);
    const costDiff = Math.abs(calcCost - summary.totalCost);
    if (tokenDiff > summary.totalTokens * TOKEN_REL_TOL && tokenDiff > TOKEN_ABS_TOL) {
      errors.push(
        `Token total mismatch: summary=${summary.totalTokens}, calculated=${calcTokens}`
      );
    }
    if (costDiff > summary.totalCost * COST_REL_TOL && costDiff > COST_ABS_TOL) {
      errors.push(
        `Cost total mismatch: summary=${summary.totalCost.toFixed(2)}, calculated=${calcCost.toFixed(2)}`
      );
    }

    // Message-only days count as active — matches the CLI's own summary
    // (early-2025 Cursor logs carry message counts without token usage).
    const activeDays = payload.contributions.filter(
      (d) => (d.totals?.tokens ?? 0) > 0 || (d.totals?.messages ?? 0) > 0
    ).length;
    if (activeDays !== summary.activeDays) {
      warnings.push(
        `Active days mismatch: summary=${summary.activeDays}, calculated=${activeDays}`
      );
    }
  }

  // Date range envelope (official: warnings).
  const range = payload.meta?.dateRange;
  if (range?.start && range?.end && DATE_RE.test(range.start) && DATE_RE.test(range.end)) {
    const dates = payload.contributions
      .map((d) => d.date)
      .filter((d) => typeof d === "string" && DATE_RE.test(d))
      .sort();
    if (dates.length > 0) {
      if (dates[0] < range.start) {
        warnings.push(`Contribution date ${dates[0]} is before dateRange.start ${range.start}`);
      }
      if (dates[dates.length - 1] > range.end) {
        warnings.push(
          `Contribution date ${dates[dates.length - 1]} is after dateRange.end ${range.end}`
        );
      }
    }
    if (range.end > maxDateStr) {
      errors.push(`Date range extends into the future: ${range.end}`);
    }
  }

  // Manifest sanity: coverage must be bounded and mode "full".
  const manifest = payload.clientManifest;
  if (manifest) {
    if (!payload.device) {
      warnings.push("clientManifest ignored: submission carries no device identity");
      payload.clientManifest = undefined;
    } else if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.clients)) {
      warnings.push("clientManifest ignored: unsupported schemaVersion");
      payload.clientManifest = undefined;
    } else {
      for (const entry of manifest.clients) {
        const cov = entry?.coverage;
        if (!cov) continue;
        if (
          cov.mode !== "full" ||
          !DATE_RE.test(cov.start ?? "") ||
          !DATE_RE.test(cov.end ?? "") ||
          cov.start > cov.end
        ) {
          errors.push(`clientManifest coverage for ${entry.client} is invalid`);
        }
      }
    }
  }

  return { errors, warnings };
}
