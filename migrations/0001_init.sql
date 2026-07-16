-- Usage rows, one per (device, day, client, model, provider).
-- Submissions are full rescans of local logs, so writes are idempotent
-- max()-guarded upserts: a shrunken rescan (log retention cleanup) can
-- never erase history already recorded here.
CREATE TABLE daily_usage (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD (client-local calendar day)
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
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, date, client, model, provider)
);

CREATE INDEX idx_daily_usage_date ON daily_usage (date);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- Lightweight audit log of accepted submissions (for debugging cadence
-- and spotting devices that stopped reporting).
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  received_at INTEGER NOT NULL,
  date_start TEXT,
  date_end TEXT,
  total_tokens INTEGER,
  total_cost REAL,
  row_count INTEGER
);
