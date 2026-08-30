-- Incident state-transition history.
--
-- The `incidents` row only ever holds the CURRENT status plus
-- detected_at/updated_at/resolved_at, so the path an incident actually
-- took through the state machine was unrecoverable after the fact. The
-- OBSERVE -> DIAGNOSE -> PLAN -> ACT -> VERIFY loop is the product's
-- central claim; this is the table that lets it be drawn.
--
-- Written by store.updateIncidentStatus() (which already holds both the
-- previous and the new status) and store.createIncident() (null -> DETECTED).
-- Incidents created before this migration have no rows here; the timeline
-- reader synthesizes an approximate history for them from the incident's
-- own timestamps rather than rendering nothing.

CREATE TABLE IF NOT EXISTS incident_timeline (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id  INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  note         TEXT,
  at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timeline_incident ON incident_timeline(incident_id, at);
