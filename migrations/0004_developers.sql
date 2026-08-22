-- Developer accounts and key lifecycle
--
-- Two separate ideas that are easy to confuse:
--
--   * A DEVELOPER signs in to a console. That session is a convenience and may
--     go down without anything else breaking.
--   * An API KEY authenticates a request from a game. It must keep working when
--     GitHub, our console, or our sign-in provider is unreachable.
--
-- Therefore: a sign-in provider never sits on the request path of the API.

-- ---------------------------------------------------------------- Developers

-- provider/provider_id identify the account at the sign-in provider
-- ('github' + numeric user id). We store no password, ever.
CREATE TABLE developers (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  provider_id    TEXT NOT NULL,
  login          TEXT NOT NULL,
  name           TEXT,
  email          TEXT,
  avatar_url     TEXT,
  two_factor     INTEGER NOT NULL DEFAULT 0,
  app_quota      INTEGER NOT NULL DEFAULT 5,
  created_at     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  UNIQUE (provider, provider_id)
);
CREATE INDEX developers_login_idx ON developers(login);

-- Console session. Only the SHA-256 hash of the cookie value is stored, the
-- same way player tokens are handled.
CREATE TABLE developer_sessions (
  token_hash    TEXT PRIMARY KEY,
  developer_id  TEXT NOT NULL REFERENCES developers(id),
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX developer_sessions_dev_idx ON developer_sessions(developer_id);

-- Short-lived state for the OAuth redirect, so a callback cannot be replayed
-- or forged from another site.
CREATE TABLE oauth_states (
  state       TEXT PRIMARY KEY,
  redirect    TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

ALTER TABLE apps ADD COLUMN owner_id TEXT REFERENCES developers(id);

-- ------------------------------------------------------------------- Keys

-- A key is an object with a life, not a column on the app. That is what makes
-- rotation with overlap, revocation, and "last used 4 months ago" possible.
--
-- kind:    'public' may live in a client, 'secret' never.
-- prefix:  the first characters, kept in clear so a key can be recognised in a
--          list and in a leak report without ever storing the key itself.
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES apps(id),
  kind          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT 'default',
  created_by    TEXT REFERENCES developers(id),
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  expires_at    TEXT,
  revoked_at    TEXT,
  revoked_by    TEXT,
  revoke_reason TEXT
);
CREATE INDEX api_keys_app_idx ON api_keys(app_id, kind);
CREATE INDEX api_keys_live_idx ON api_keys(revoked_at);

-- ------------------------------------------------------------- Audit trail

-- Every action that changes access or moderation state. Separate from `events`
-- because this one answers "who did that", not "what happened to a player".
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_kind    TEXT NOT NULL,
  actor_id      TEXT,
  actor_label   TEXT,
  action        TEXT NOT NULL,
  subject       TEXT,
  detail        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_kind, actor_id, id);
CREATE INDEX audit_log_action_idx ON audit_log(action, id);
