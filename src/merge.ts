/**
 * Per-(device, day, client) merge engine, porting the official server's
 * helpers (packages/frontend/src/lib/db/helpers.ts):
 *
 *   - aggregateIncomingClientBreakdowns: sum duplicate model rows, track
 *     provenance (client revision = min across its rows).
 *   - deriveStoredClientRevisionFloors / filterClientBreakdownsByRevisionFloor:
 *     a client whose parser revision is older than any stored revision for
 *     that client on this device is rejected wholesale.
 *   - applyAuthoritativeClientCoverage: clientManifest full-coverage windows
 *     delete stored rows for covered (client, day) before merge; days the
 *     incoming payload no longer mentions are tombstoned.
 *   - mergeClientBreakdownsWithRegressionGuard: per day and client, incoming
 *     data replaces stored data unless it would regress (older parser
 *     revision, or fewer tokens within the same revision).
 *
 * Storage model: client-level data lives as one row per (client, model,
 * provider); client totals are the sum of its model rows.
 */

import type { ClientContribution, DailyContribution, ManifestEntry } from "./payload";

export interface ModelMetrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  messages: number;
  cost: number;
}

/** modelKey = model + "\u0000" + provider */
export interface ClientDayData {
  revision: number;
  models: Map<string, ModelMetrics>;
}

export type DayState = Map<string, ClientDayData>; // key: client
export type DeviceState = Map<string, DayState>; // key: date

export function modelKey(model: string, provider: string): string {
  return `${model}\u0000${provider}`;
}

export function clientTokens(c: ClientDayData): number {
  let sum = 0;
  for (const m of c.models.values()) {
    sum += m.input + m.output + m.cacheRead + m.cacheWrite + m.reasoning;
  }
  return sum;
}

function addInto(target: ModelMetrics, src: ModelMetrics): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheWrite += src.cacheWrite;
  target.reasoning += src.reasoning;
  target.messages += src.messages;
  target.cost += src.cost;
}

/** Aggregate one day's incoming client rows into per-client state. */
export function aggregateIncomingDay(clients: ClientContribution[]): DayState {
  const day: DayState = new Map();
  for (const c of clients) {
    const revision = Math.max(1, c.provenance?.schemaVersion ?? 1);
    const key = modelKey(c.modelId, c.providerId ?? "");
    const metrics: ModelMetrics = {
      input: c.tokens.input,
      output: c.tokens.output,
      cacheRead: c.tokens.cacheRead,
      cacheWrite: c.tokens.cacheWrite,
      reasoning: c.tokens.reasoning,
      messages: c.messages,
      cost: c.cost,
    };
    const existing = day.get(c.client);
    if (!existing) {
      day.set(c.client, { revision, models: new Map([[key, metrics]]) });
      continue;
    }
    // Official aggregateIncomingClientBreakdowns keeps the min schemaVersion.
    existing.revision = Math.min(existing.revision, revision);
    const model = existing.models.get(key);
    if (model) {
      addInto(model, metrics);
    } else {
      existing.models.set(key, metrics);
    }
  }
  return day;
}

/** Max stored revision per client across every day of this device. */
export function deriveRevisionFloors(stored: DeviceState): Map<string, number> {
  const floors = new Map<string, number>();
  for (const day of stored.values()) {
    for (const [client, data] of day) {
      floors.set(client, Math.max(floors.get(client) ?? 1, data.revision));
    }
  }
  return floors;
}

export interface CoverageWindow {
  client: string;
  start: string;
  end: string;
}

export function extractCoverages(entries: ManifestEntry[] | undefined): CoverageWindow[] {
  if (!entries) return [];
  const out: CoverageWindow[] = [];
  for (const e of entries) {
    if (e?.coverage?.mode === "full") {
      out.push({ client: e.client, start: e.coverage.start, end: e.coverage.end });
    }
  }
  return out;
}

function cloneClientData(c: ClientDayData): ClientDayData {
  const models = new Map<string, ModelMetrics>();
  for (const [k, v] of c.models) models.set(k, { ...v });
  return { revision: c.revision, models };
}

export interface DayMergeResult {
  merged: DayState;
  warnings: string[];
}

/**
 * Merge one day. `storedDay` may be undefined (new day). `incomingDay` is
 * undefined for stored days absent from this submission (coverage-only pass).
 */
export function mergeDay(
  date: string,
  storedDay: DayState | undefined,
  incomingDay: DayState | undefined,
  submittedClients: ReadonlySet<string>,
  rejectedClients: ReadonlySet<string>,
  coverages: CoverageWindow[]
): DayMergeResult {
  const warnings: string[] = [];
  const merged: DayState = new Map();
  for (const [client, data] of storedDay ?? new Map<string, ClientDayData>()) {
    merged.set(client, cloneClientData(data));
  }

  // Authoritative coverage: drop stored rows for covered clients first.
  for (const cov of coverages) {
    if (date < cov.start || date > cov.end) continue;
    if (!merged.has(cov.client)) continue;
    merged.delete(cov.client);
    if (!incomingDay?.has(cov.client)) {
      warnings.push(
        `Day ${date}: Removed stale ${cov.client} data under authoritative replacement coverage.`
      );
    }
  }

  if (!incomingDay) return { merged, warnings };

  for (const client of submittedClients) {
    if (rejectedClients.has(client)) continue;
    const incoming = incomingDay.get(client);
    const stored = merged.get(client);

    if (!incoming) {
      if (stored && clientTokens(stored) > 0) {
        warnings.push(
          `Day ${date}: Preserved ${client} because it disappeared from this same-device resubmit; kept ${clientTokens(stored).toLocaleString("en-US")} tokens.`
        );
      } else {
        merged.delete(client);
      }
      continue;
    }

    if (stored) {
      if (incoming.revision < stored.revision) {
        warnings.push(
          `Day ${date}: Preserved ${client} because parser revision ${incoming.revision} is older than stored revision ${stored.revision}.`
        );
        continue;
      }
      const incomingTokens = clientTokens(incoming);
      const storedTokens = clientTokens(stored);
      if (incoming.revision === stored.revision && incomingTokens < storedTokens) {
        // Within one parser revision a token decrease signals a regression
        // (e.g. the CLI re-parsed only a subset of history).
        warnings.push(
          `Day ${date}: Preserved ${client} because this same-device resubmit would reduce ${storedTokens.toLocaleString("en-US")} tokens to ${incomingTokens.toLocaleString("en-US")}.`
        );
        continue;
      }
    }

    merged.set(client, cloneClientData(incoming));
  }

  return { merged, warnings };
}

/**
 * The CLI recomputes costs from scratch on every scan; float summation order
 * makes consecutive scans differ by ~1e-14. Treat sub-1e-9 relative cost
 * drift as equal so periodic resubmits don't rewrite unchanged days.
 */
function costEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

export function daysEqual(a: DayState | undefined, b: DayState): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [client, bData] of b) {
    const aData = a.get(client);
    if (!aData || aData.revision !== bData.revision) return false;
    if (aData.models.size !== bData.models.size) return false;
    for (const [key, bm] of bData.models) {
      const am = aData.models.get(key);
      if (
        !am ||
        am.input !== bm.input ||
        am.output !== bm.output ||
        am.cacheRead !== bm.cacheRead ||
        am.cacheWrite !== bm.cacheWrite ||
        am.reasoning !== bm.reasoning ||
        am.messages !== bm.messages ||
        !costEqual(am.cost, bm.cost)
      ) {
        return false;
      }
    }
  }
  return true;
}

export function collectSubmittedClients(
  summaryClients: string[] | undefined,
  contributions: DailyContribution[]
): Set<string> {
  const set = new Set<string>();
  for (const c of summaryClients ?? []) {
    if (typeof c === "string" && c !== "") set.add(c);
  }
  for (const day of contributions) {
    for (const c of day.clients) set.add(c.client);
  }
  if (set.has("kilo")) set.add("kilocode");
  return set;
}
