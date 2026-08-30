-- Activity/audit events, persisted. Replaces the RAM-only 500-event ring
-- buffer — previously everything was lost on restart, which defeats the
-- point of an audit trail.

CREATE TABLE IF NOT EXISTS activity_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  details     TEXT,
  timestamp   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_events(timestamp DESC);
