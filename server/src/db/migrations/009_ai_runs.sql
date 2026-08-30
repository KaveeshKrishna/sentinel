-- Every AI provider call, successful or not: diagnosis attempts (incl.
-- the one malformed-JSON retry) and Settings' "test connection" pings.
-- request_summary/raw_response are redacted (server/src/ai/redact.js)
-- before being persisted here — never store the API key itself.

CREATE TABLE IF NOT EXISTS ai_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id         INTEGER,
  purpose             TEXT NOT NULL,   -- 'diagnosis' | 'test_connection'
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 1,
  request_summary     TEXT,
  raw_response        TEXT,
  parsed_json         TEXT,
  error               TEXT,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  latency_ms          INTEGER,
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_incident ON ai_runs(incident_id);
