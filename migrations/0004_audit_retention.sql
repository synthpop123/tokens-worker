-- The submission audit log becomes a rolling 30-day window (the DELETE
-- rides along in every submission's batch, see src/submit.ts), so this
-- migration drops what a bounded log no longer needs.
--
--   - warning_count: a bare integer with no text behind it was never
--     actionable — the warnings themselves go back to the CLI in the
--     submit response, which is where they are read.
--
-- Append-only, like every migration here: D1 records applied files by
-- name, so this one is added rather than folded into 0003_rebuild.sql.
ALTER TABLE submissions DROP COLUMN warning_count;

-- One-off trim of the backlog the retention window inherits; from here on
-- the per-submission DELETE keeps it flat.
DELETE FROM submissions
WHERE received_at < (unixepoch() - 30 * 86400) * 1000;
