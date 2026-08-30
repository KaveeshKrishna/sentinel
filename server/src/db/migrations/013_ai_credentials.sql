-- Multiple AI provider credentials with an explicit failover order.
--
-- Phase 3 stored exactly one provider in `settings` (ai.provider /
-- ai.model / ai.baseUrl / ai.apiKeyEnc). A single credential means one
-- exhausted free-tier quota, one revoked key, or one provider outage
-- stops diagnosis, chat and reports outright — and the failures seen in
-- real use (OpenRouter's intermittent 404s, Gemini's 20/day cap) are
-- exactly the kind another key would ride through.
--
-- `priority` is the failover order, ascending: the lowest enabled row is
-- tried first, and each subsequent one only after the previous fails.
-- `last_error`/`last_error_at`/`last_ok_at` are health, not audit — the
-- per-call record still goes to `ai_runs`; these exist so the Settings
-- page can say *why* a key is being skipped without joining that table.
--
-- The API key column holds the same AES-256-GCM ciphertext format the
-- `settings` row did (crypto/aesGcm.js, key from /etc/sentinel/secret.key),
-- so the backfill below can move it across verbatim.

CREATE TABLE IF NOT EXISTS ai_credentials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT    NOT NULL,
  provider       TEXT    NOT NULL,
  model          TEXT,
  base_url       TEXT,
  api_key_enc    TEXT    NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_error     TEXT,
  last_error_at  INTEGER,
  last_ok_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_credentials_priority
  ON ai_credentials(enabled, priority);

-- Carry an existing single-provider install across, so upgrading does not
-- silently un-configure a working AI provider. Only fires when a saved
-- key actually exists (an env-var-only bootstrap config is left alone —
-- it is still read as a last-resort fallback, see settings/aiConfig.js).
INSERT INTO ai_credentials (label, provider, model, base_url, api_key_enc, priority, enabled, created_at, updated_at)
SELECT
  'Primary',
  (SELECT value FROM settings WHERE key = 'ai.provider'),
  (SELECT value FROM settings WHERE key = 'ai.model'),
  (SELECT value FROM settings WHERE key = 'ai.baseUrl'),
  (SELECT value FROM settings WHERE key = 'ai.apiKeyEnc'),
  0, 1,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE (SELECT value FROM settings WHERE key = 'ai.apiKeyEnc') IS NOT NULL
  AND (SELECT value FROM settings WHERE key = 'ai.provider')   IS NOT NULL;
