-- Settings: generic key/value store for runtime configuration that isn't
-- a secret file (AI provider config in Phase 3, the one-time setup token,
-- future policy overrides). Secrets that must never be readable outside
-- this process (encrypted AI API keys) still go through the same table,
-- but encrypted at rest — see ARCHITECTURE.md security decisions.

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  INTEGER NOT NULL
);
