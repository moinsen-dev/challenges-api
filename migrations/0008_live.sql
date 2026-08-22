-- The live layer: presence, a queue, join tickets, and webhooks
--
-- Two architectural notes that belong next to the tables rather than in a
-- commit message:
--
--   * There is no Durable Object here. A queue wants serialisation, and a DO
--     is the textbook answer. D1 is single-writer per database, so a claim
--     expressed as one conditional UPDATE is already serialised; what remains
--     is a compensating step when a claim wins only half a pairing. That is
--     simpler to reason about and to test. If contention ever becomes real,
--     the queue moves into a DO and nothing above it changes.
--
--   * Signing needs a secret we can actually use. App keys are stored as
--     hashes and cannot sign anything, so an app gets one signing secret,
--     kept in recoverable form. It is the only secret here that is, and it is
--     documented as such.

ALTER TABLE apps ADD COLUMN signing_secret TEXT;
UPDATE apps SET signing_secret = lower(hex(randomblob(32))) WHERE signing_secret IS NULL;

-- Who is around right now. Deliberately coarse: a timestamp, not a location.
CREATE TABLE presence (
  player_id   TEXT NOT NULL REFERENCES players(id),
  app_id      TEXT NOT NULL REFERENCES apps(id),
  status      TEXT NOT NULL DEFAULT 'online',
  detail      TEXT,
  last_seen   TEXT NOT NULL,
  PRIMARY KEY (player_id, app_id)
);
CREATE INDEX presence_app_idx ON presence(app_id, last_seen);

-- state: 'waiting' | 'matched' | 'cancelled' | 'expired'
CREATE TABLE queue_tickets (
  id             TEXT PRIMARY KEY,
  app_id         TEXT NOT NULL REFERENCES apps(id),
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  player_id      TEXT NOT NULL REFERENCES players(id),
  party_id       TEXT,
  region_id      TEXT REFERENCES regions(id),
  rating         REAL NOT NULL DEFAULT 1500,
  state          TEXT NOT NULL DEFAULT 'waiting',
  pairing_id     TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  matched_at     TEXT
);
CREATE INDEX queue_waiting_idx ON queue_tickets(discipline_id, state, rating, created_at);
CREATE INDEX queue_player_idx ON queue_tickets(player_id, state);
CREATE INDEX queue_pairing_idx ON queue_tickets(pairing_id);

CREATE TABLE pairings (
  id             TEXT PRIMARY KEY,
  app_id         TEXT NOT NULL REFERENCES apps(id),
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  region_id      TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

-- Where an app wants to be told rather than to ask.
CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES apps(id),
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,
  events        TEXT NOT NULL DEFAULT '*',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_error    TEXT,
  last_success  TEXT
);
CREATE INDEX webhooks_app_idx ON webhooks(app_id, active);

-- state: 'pending' | 'delivered' | 'failed'
CREATE TABLE webhook_deliveries (
  id           TEXT PRIMARY KEY,
  webhook_id   TEXT NOT NULL REFERENCES webhooks(id),
  event_type   TEXT NOT NULL,
  payload      TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_try_at  TEXT NOT NULL,
  last_status  INTEGER,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(state, next_try_at);
