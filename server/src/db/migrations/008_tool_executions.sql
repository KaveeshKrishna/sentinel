-- Complete audit trail of every agent tool call made on an incident's
-- behalf (context gathering, remediation, verification). Populated by
-- the single shared wrapper in server/src/incidents/toolCallAudit.js so
-- this table is exhaustive by construction rather than by convention.

CREATE TABLE IF NOT EXISTS tool_executions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id         INTEGER,
  incident_action_id  INTEGER,
  tool_name           TEXT NOT NULL,
  params_json         TEXT NOT NULL,
  real_risk           TEXT,
  approved            INTEGER NOT NULL DEFAULT 0,
  requested_by        TEXT NOT NULL,   -- 'detector' | 'context' | 'diagnosis' | 'remediation' | 'verification' | 'user'
  status              TEXT NOT NULL,   -- 'ok' | 'error'
  result_json         TEXT,
  error               TEXT,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  FOREIGN KEY (incident_action_id) REFERENCES incident_actions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_executions_incident ON tool_executions(incident_id);
