-- Learned-runbook matching (incidents/runbooks.js) queries incidents by
-- trigger_rule and incident_actions by (incident_id, status, tool_name)
-- together; neither combination has an index today (incidents only
-- indexes status and detected_at; incident_actions only indexes
-- incident_id). Cheap now, and this is the one place a full-table scan
-- would otherwise happen on every fresh incident's first diagnosis.

CREATE INDEX IF NOT EXISTS idx_incidents_trigger_rule ON incidents(trigger_rule);
CREATE INDEX IF NOT EXISTS idx_actions_incident_status_tool ON incident_actions(incident_id, status, tool_name);
