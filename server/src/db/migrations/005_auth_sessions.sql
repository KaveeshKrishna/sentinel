-- Server-side session tracking so logout (and a future "sign out other
-- sessions" control) actually revokes a token, instead of the JWT simply
-- remaining valid for its full lifetime after the cookie is cleared.
-- Named auth_sessions to avoid colliding with the unrelated recording
-- domain's `sessions` table (VPS health recording sessions).

CREATE TABLE IF NOT EXISTS auth_sessions (
  jti         TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
