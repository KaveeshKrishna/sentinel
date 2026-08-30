-- Per-credential quota awareness + notification state.
--
-- Free provider tiers have hard, low ceilings (the Gemini free tier this
-- install uses allows 5 requests/minute and 20/day), and Sentinel's own
-- background work — the detector's stuck/stale re-drives, diagnosis
-- retries, post-incident reports — can burn a whole day's allowance in
-- minutes without a person doing anything. Spending a request only to be
-- told 429 is the worst outcome: it costs the quota AND fails the call.
--
-- So a credential now carries its own budget, checked BEFORE a request is
-- made rather than after it is refused:
--   rpm_limit / rpd_limit  optional caps (NULL = no local cap)
--   cooldown_until         set automatically when a provider says 429,
--                          so a rate-limited key is skipped instead of
--                          re-asked on every subsequent call
--   notified_error         the failure already announced to the operator,
--                          so repeating the same failure on every request
--                          doesn't produce a fresh notification each time
--
-- `ai_credential_calls` is what the RPM/RPD counters count. Deliberately
-- its own table rather than counting `ai_runs`: those rows are written by
-- each *caller* (orchestrator/chat/report) in its own shape, so a caller
-- that forgot would silently switch the limit off. This one is written by
-- ai/failover.js itself, on every attempt it makes, so the budget is
-- correct by construction. It is also tiny and pruned to the widest
-- window anything asks about, unlike ai_runs which keeps full payloads.
--
-- `ai_runs.credential_id` is still recorded, for the audit question
-- "which key produced this diagnosis" — just not for counting.

ALTER TABLE ai_credentials ADD COLUMN rpm_limit      INTEGER;
ALTER TABLE ai_credentials ADD COLUMN rpd_limit      INTEGER;
ALTER TABLE ai_credentials ADD COLUMN cooldown_until INTEGER;
ALTER TABLE ai_credentials ADD COLUMN notified_error TEXT;

ALTER TABLE ai_runs ADD COLUMN credential_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_ai_runs_credential ON ai_runs(credential_id, created_at);

CREATE TABLE IF NOT EXISTS ai_credential_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (credential_id) REFERENCES ai_credentials(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_credential_calls
  ON ai_credential_calls(credential_id, created_at);
