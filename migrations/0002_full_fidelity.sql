-- Full-fidelity storage for the official tokens CLI submission payload.
--
-- parser_revision: per-(client, day) parser schema version from contribution
-- provenance. Floors reject stale-parser resubmits; within one revision a
-- token decrease is treated as a regression (official semantics).
ALTER TABLE daily_usage ADD COLUMN parser_revision INTEGER NOT NULL DEFAULT 1;

-- Per-(device, day) metadata that is not part of the usage matrix.
CREATE TABLE daily_meta (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  timestamp_ms INTEGER,   -- earliest-wins merge (official mergeTimestampMs)
  active_time_ms INTEGER, -- incoming ?? existing
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, date)
);

-- Device-level metadata from the submission envelope.
ALTER TABLE devices ADD COLUMN cli_version TEXT;
ALTER TABLE devices ADD COLUMN total_active_time_ms INTEGER;
ALTER TABLE devices ADD COLUMN longest_continuous_ms INTEGER;
ALTER TABLE devices ADD COLUMN max_concurrent_sessions INTEGER;
ALTER TABLE devices ADD COLUMN session_count INTEGER;
ALTER TABLE devices ADD COLUMN mcp_servers TEXT; -- JSON array

-- Submission audit enrichment.
ALTER TABLE submissions ADD COLUMN cli_version TEXT;
ALTER TABLE submissions ADD COLUMN generated_at TEXT;
ALTER TABLE submissions ADD COLUMN mode TEXT; -- create | merge
ALTER TABLE submissions ADD COLUMN warning_count INTEGER;

CREATE INDEX idx_daily_usage_client ON daily_usage (client);
CREATE INDEX idx_daily_usage_model ON daily_usage (model);
