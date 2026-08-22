-- Recovery for players: passkeys, optional email, visible sessions
--
-- The promise so far was "an account needs no personal data at all". That
-- stays true: a passkey is a public key and an opaque credential id — nothing
-- about a person. Email is strictly opt-in and exists only so somebody who
-- wants a rescue route can have one.
--
-- What this fixes: today, losing the device without an open link code loses
-- the account, and with it every title.

-- Public key credentials. `public_key` is SPKI DER, base64. There is no
-- attestation here on purpose: we do not care which authenticator was used,
-- only that the same one comes back.
CREATE TABLE passkeys (
  id             TEXT PRIMARY KEY,
  player_id      TEXT NOT NULL REFERENCES players(id),
  credential_id  TEXT NOT NULL UNIQUE,
  public_key     TEXT NOT NULL,
  algorithm      INTEGER NOT NULL DEFAULT -7,
  label          TEXT NOT NULL DEFAULT 'passkey',
  sign_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_used_at   TEXT
);
CREATE INDEX passkeys_player_idx ON passkeys(player_id);

-- One-shot challenges for registration and authentication. Stored server side
-- so a replayed ceremony is dead, and short lived so a stolen one is useless.
CREATE TABLE webauthn_challenges (
  challenge   TEXT PRIMARY KEY,
  player_id   TEXT REFERENCES players(id),
  purpose     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

-- Optional rescue address. Unverified until the link is opened; only a
-- verified address can ever recover an account.
ALTER TABLE players ADD COLUMN recovery_email TEXT;
ALTER TABLE players ADD COLUMN recovery_verified_at TEXT;

CREATE UNIQUE INDEX players_recovery_email_idx
  ON players(recovery_email) WHERE recovery_email IS NOT NULL;

CREATE TABLE recovery_tokens (
  id           TEXT PRIMARY KEY,
  player_id    TEXT REFERENCES players(id),
  email        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  purpose      TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);
CREATE INDEX recovery_tokens_email_idx ON recovery_tokens(email, created_at);

-- Sessions become something a player can see and end. Until now they were
-- invisible, which is the same as not existing when a device is lost.
ALTER TABLE sessions ADD COLUMN label TEXT;
ALTER TABLE sessions ADD COLUMN revoked_at TEXT;
