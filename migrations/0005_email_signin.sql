-- Email magic-link sign-in, as a second path next to GitHub
--
-- Deliberate decisions encoded here:
--
--   * One row carries BOTH a long link token and a six-digit code. The link is
--     convenient; the code is what you use when the mail opens on your phone
--     but you started in the browser on your desk.
--   * `attempts` exists because six digits are only a million possibilities.
--     A code dies after a handful of wrong guesses, or it is not a secret.
--   * Only hashes are stored, the same as every other credential here.

CREATE TABLE login_tokens (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  code_hash    TEXT NOT NULL,
  redirect     TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);
CREATE INDEX login_tokens_email_idx ON login_tokens(email, created_at);
