-- The incident state machine: DETECTED -> INVESTIGATING -> DIAGNOSED ->
-- AWAITING_APPROVAL -> REMEDIATING -> VERIFYING -> RESOLVED | FAILED, with
-- DISMISSED reachable from any non-terminal state. See
-- server/src/incidents/states.js for the transition guard.
--
-- The partial unique index below is the real dedupe mechanism (not just
-- an application-level check-then-insert): only one non-terminal incident
-- may exist per resource at a time.

CREATE TABLE IF NOT EXISTS incidents (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id         INTEGER NOT NULL,
  status              TEXT NOT NULL,
  severity            TEXT NOT NULL DEFAULT 'unknown',
  trigger_rule        TEXT NOT NULL,
  trigger_summary     TEXT NOT NULL,
  root_cause          TEXT,
  confidence          REAL,
  diagnosis_json      TEXT,
  diagnosis_raw_text  TEXT,
  detected_at         INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  resolved_at         INTEGER,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_open_resource
  ON incidents(resource_id)
  WHERE status NOT IN ('RESOLVED', 'FAILED', 'DISMISSED');

CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_detected ON incidents(detected_at DESC);

CREATE TABLE IF NOT EXISTS incident_evidence (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id   INTEGER NOT NULL,
  resource_id   INTEGER,             -- which node this evidence is *about* (may be a neighbour)
  source_tool   TEXT NOT NULL,
  summary       TEXT NOT NULL,
  data_json     TEXT,
  collected_at  INTEGER NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_incident ON incident_evidence(incident_id);

CREATE TABLE IF NOT EXISTS incident_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id   INTEGER NOT NULL,
  tool_name     TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  claimed_risk  TEXT,                -- from the AI's own JSON — display-only, never trusted
  real_risk     TEXT NOT NULL,       -- from the agent's live tool catalog — authoritative
  rationale     TEXT,
  status        TEXT NOT NULL,       -- 'proposed' | 'approved' | 'executed' | 'failed' | 'dismissed'
  approved_by   INTEGER,
  approved_at   INTEGER,
  executed_at   INTEGER,
  result_json   TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_actions_incident ON incident_actions(incident_id);
