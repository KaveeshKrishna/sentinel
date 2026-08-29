-- Post-incident reports, and how an action came to be approved.

-- The AI-written RCA, stored structured rather than as markdown: it stays
-- ajv-validated like every other AI call, and the UI renders components
-- instead of parsing untrusted markdown. The markdown for the copy button
-- is derived from these fields server-side.
ALTER TABLE incidents ADD COLUMN report_json TEXT;
ALTER TABLE incidents ADD COLUMN report_generated_at INTEGER;

-- Which path approved an action: 'ui' | 'link' | 'auto'.
--
-- This closes a real ambiguity rather than adding decoration. Until now
-- `approved_by IS NULL` doubled as the machine-approved marker, and
-- settings/autoRemediate.js counts exactly those rows for its 3/hour
-- rate limit. A one-click approval from a Slack/Discord notification
-- also has no user id, so it would have silently consumed the
-- auto-remediation budget and been indistinguishable from a machine
-- approval in the audit trail.
--
-- Existing rows keep NULL here; the rate-limit query treats
-- (approved_via IS NULL AND approved_by IS NULL) as 'auto' so historical
-- machine approvals still count correctly.
ALTER TABLE incident_actions ADD COLUMN approved_via TEXT;
