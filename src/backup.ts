/**
 * Long-term backups in R2, beyond D1's 30-day Time Travel window.
 *
 * Daily export: the first accepted submission of each Asia/Shanghai day
 * dumps the usage tables as JSON to backup/YYYY-MM-DD.json (idempotent —
 * later submissions see the object exists and return). Restoring after a
 * schema change is a matter of replaying these rows.
 *
 * What the export deliberately leaves out is `submissions`: it is an
 * operations log, not data anyone would restore, and copying an
 * append-only log into a new object *every day* makes storage grow with
 * the square of time. (It is now a rolling 30-day window anyway — see
 * src/submit.ts.) Retention below bounds the other half of that growth:
 * the exports themselves are pruned past BACKUP_RETENTION_DAYS.
 *
 * Raw payload archive: the write path keeps each device's latest full
 * submission verbatim under raw/<deviceId>/latest.json (see submit.ts).
 * Submissions are full rescans, so the latest one reproduces the device's
 * whole history — and since the key is fixed per device, that archive
 * overwrites in place and never grows.
 */

import type { Env } from "./http";
import { isoToday } from "./http";

const BACKUP_PREFIX = "backup/";

/** How far back the daily exports are kept. Well past D1's 30-day Time
 *  Travel window, which covers the recent end far better than a JSON
 *  dump does. */
const BACKUP_RETENTION_DAYS = 180;

/**
 * Delete every object in the archive bucket. Raw payload archives and
 * daily exports both reproduce submitted data, so "delete submitted
 * data" must cover them — retaining backups would silently break that
 * promise. R2 lists and deletes in pages of up to 1000 keys.
 */
export async function wipeArchive(env: Env): Promise<void> {
  let cursor: string | undefined;
  do {
    const listing = await env.ARCHIVE.list({ cursor });
    if (listing.objects.length > 0) {
      await env.ARCHIVE.delete(listing.objects.map((object) => object.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

/**
 * Drop exports older than the retention window. Keys are
 * `backup/YYYY-MM-DD.json`, so the cutoff is a string comparison — no
 * date parsing, and lexicographic order matches chronological order.
 */
async function pruneBackups(env: Env, today: string): Promise<void> {
  const cutoff = new Date(`${today}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - BACKUP_RETENTION_DAYS);
  const oldest = `${BACKUP_PREFIX}${cutoff.toISOString().slice(0, 10)}.json`;

  let cursor: string | undefined;
  do {
    const listing = await env.ARCHIVE.list({ prefix: BACKUP_PREFIX, cursor });
    const stale = listing.objects.filter((object) => object.key < oldest).map((o) => o.key);
    if (stale.length > 0) await env.ARCHIVE.delete(stale);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

export async function ensureDailyBackup(env: Env): Promise<void> {
  const today = isoToday();
  const key = `${BACKUP_PREFIX}${today}.json`;
  if ((await env.ARCHIVE.head(key)) !== null) return;

  const [usage, activity, devices] = await env.DB.batch([
    env.DB.prepare(
      `SELECT device_id, date, client, model, provider, input, output,
              cache_read, cache_write, reasoning, messages, cost, parser_revision
       FROM daily_usage ORDER BY device_id, date`
    ),
    env.DB.prepare(
      `SELECT device_id, date, active_time_ms FROM daily_activity ORDER BY device_id, date`
    ),
    env.DB.prepare(`SELECT * FROM devices`),
  ]);

  await env.ARCHIVE.put(
    key,
    JSON.stringify({
      exportedAt: new Date().toISOString(),
      schema: "0004_audit_retention",
      daily_usage: usage.results,
      daily_activity: activity.results,
      devices: devices.results,
    }),
    { httpMetadata: { contentType: "application/json" } }
  );

  // Only ever reached once per day, right after a fresh export landed.
  await pruneBackups(env, today);
}
