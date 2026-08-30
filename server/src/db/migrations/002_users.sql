-- Users: replaces the single env-configured admin account. `role` is
-- carried now so the authorization layer doesn't need another migration
-- to introduce roles later (see ARCHITECTURE.md decision on RBAC) — only
-- 'owner' is actually issued today.

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'owner',
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);
