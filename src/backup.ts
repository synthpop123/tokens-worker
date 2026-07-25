/**
 * Long-term backups in R2, beyond D1's 30-day Time Travel window.
 *
 * Daily export: the first accepted submission of each Asia/Shanghai day
 * dumps all four tables as JSON to backup/YYYY-MM-DD.json (idempotent —
 * later submissions see the object exists and return). Restoring after a
 * schema change is a matter of replaying these rows.
 *
 * Raw payload archive: the write path keeps each device's latest full
 * submission verbatim under raw/<deviceId>/latest.json (see submit.ts).
 * Submissions are full rescans, so the latest one reproduces the device's
 * whole history.
 */

import type { Env } from "./http";
import { isoToday } from "./http";

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

export async function ensureDailyBackup(env: Env): Promise<void> {
  const key = `backup/${isoToday()}.json`;
  if ((await env.ARCHIVE.head(key)) !== null) return;

  const [usage, activity, devices, submissions] = await env.DB.batch([
    env.DB.prepare(
      `SELECT device_id, date, client, model, provider, input, output,
              cache_read, cache_write, reasoning, messages, cost, parser_revision
       FROM daily_usage ORDER BY device_id, date`
    ),
    env.DB.prepare(
      `SELECT device_id, date, active_time_ms FROM daily_activity ORDER BY device_id, date`
    ),
    env.DB.prepare(`SELECT * FROM devices`),
    env.DB.prepare(`SELECT * FROM submissions ORDER BY received_at`),
  ]);

  await env.ARCHIVE.put(
    key,
    JSON.stringify({
      exportedAt: new Date().toISOString(),
      schema: "0003_rebuild",
      daily_usage: usage.results,
      daily_activity: activity.results,
      devices: devices.results,
      submissions: submissions.results,
    }),
    { httpMetadata: { contentType: "application/json" } }
  );
}
