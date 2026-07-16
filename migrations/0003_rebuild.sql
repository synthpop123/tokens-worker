-- Clean rebuild (breaking, wipes data — devices re-upload their full history
-- on the next submit, which the merge semantics treat as a fresh create).
--
-- Changes vs the 0001+0002 lineage:
--   - WITHOUT ROWID for the composite-PK tables (smaller, faster PK access)
--   - daily_usage.updated_at dropped (freshness = devices.last_seen)
--   - daily_meta -> daily_activity: timestamp_ms dropped (the current CLI
--     never sends timestampMs; it was a pre-v2.1 field)
--   - submissions gains changed_days; NOT NULL tightened everywhere
DROP TABLE IF EXISTS daily_usage;
DROP TABLE IF EXISTS daily_meta;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS submissions;

-- The usage matrix: one row per (device, day, client, model, provider).
CREATE TABLE daily_usage (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD, client-local calendar day
  client TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  -- Parser schema version from contribution provenance; merge floors and the
  -- regression guard key off it (see src/merge.ts).
  parser_revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (device_id, date, client, model, provider)
) WITHOUT ROWID;

CREATE INDEX idx_usage_date ON daily_usage (date);
CREATE INDEX idx_usage_client_date ON daily_usage (client, date);
CREATE INDEX idx_usage_model ON daily_usage (model);

-- Per-(device, day) active time from the submission envelope.
CREATE TABLE daily_activity (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  active_time_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, date)
) WITHOUT ROWID;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  cli_version TEXT,
  total_active_time_ms INTEGER,
  longest_continuous_ms INTEGER,
  max_concurrent_sessions INTEGER,
  session_count INTEGER,
  mcp_servers TEXT -- JSON array
);

-- Audit log of accepted submissions.
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  total_tokens INTEGER NOT NULL,
  total_cost REAL NOT NULL,
  row_count INTEGER NOT NULL,     -- usage rows written
  changed_days INTEGER NOT NULL,  -- days rewritten
  cli_version TEXT,
  generated_at TEXT,
  mode TEXT NOT NULL,             -- create | merge
  warning_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_submissions_received ON submissions (received_at DESC);
