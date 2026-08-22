-- Access and social layer v1
--
-- Everything here follows from one fact: once a leaderboard is public, people
-- meet each other. Then you need profiles, boundaries between people, a path
-- for complaints, and a door you can open deliberately.
--

-- ------------------------------------------------------------------ Profiles

-- status: 'active' | 'suspended' | 'banned'
-- A banned player disappears from leaderboards and titles; their entries stay
-- in the ledger — deletion happens only on their own request.
ALTER TABLE players ADD COLUMN display_name TEXT;
ALTER TABLE players ADD COLUMN avatar TEXT;
ALTER TABLE players ADD COLUMN locale TEXT;
ALTER TABLE players ADD COLUMN featured_title TEXT REFERENCES titles(id);
ALTER TABLE players ADD COLUMN featured_badge TEXT REFERENCES badges(id);
ALTER TABLE players ADD COLUMN handle_changed_at TEXT;
ALTER TABLE players ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE players ADD COLUMN status_until TEXT;
ALTER TABLE players ADD COLUMN status_reason TEXT;
ALTER TABLE players ADD COLUMN invited_by TEXT REFERENCES players(id);
ALTER TABLE players ADD COLUMN invites_left INTEGER NOT NULL DEFAULT 0;

-- ------------------------------------------------------------ Rivals & blocks

-- One-sided and without a confirmation dance: following someone puts them on
-- your rivals list. That carries a friends leaderboard without a request inbox.
CREATE TABLE follows (
  follower_id  TEXT NOT NULL REFERENCES players(id),
  followee_id  TEXT NOT NULL REFERENCES players(id),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX follows_followee_idx ON follows(followee_id);

-- A block cuts contact in both directions: no challenge, no visibility in
-- search. It does NOT affect leaderboards — otherwise the same results would
-- have different truths depending on who is looking.
CREATE TABLE blocks (
  blocker_id  TEXT NOT NULL REFERENCES players(id),
  blocked_id  TEXT NOT NULL REFERENCES players(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks(blocked_id);

-- ------------------------------------------------------------------ Reports

-- state: 'open' | 'resolved'
-- action: 'none' | 'rename' | 'suspend' | 'ban'
CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  app_id        TEXT REFERENCES apps(id),
  reporter_id   TEXT NOT NULL REFERENCES players(id),
  subject_id    TEXT NOT NULL REFERENCES players(id),
  reason        TEXT NOT NULL,
  detail        TEXT,
  state         TEXT NOT NULL DEFAULT 'open',
  action        TEXT,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX reports_state_idx ON reports(state, created_at);
CREATE UNIQUE INDEX reports_once_idx ON reports(reporter_id, subject_id, state);

-- ------------------------------------------------------------------ Invites

-- access_mode: 'open' | 'invite'
ALTER TABLE apps ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'open';
ALTER TABLE apps ADD COLUMN invites_per_player INTEGER NOT NULL DEFAULT 0;

CREATE TABLE invites (
  code_hash    TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES apps(id),
  created_by   TEXT REFERENCES players(id),
  max_uses     INTEGER NOT NULL DEFAULT 1,
  uses         INTEGER NOT NULL DEFAULT 0,
  region_id    TEXT REFERENCES regions(id),
  note         TEXT,
  expires_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX invites_creator_idx ON invites(created_by);

-- --------------------------------------------------------------- Waitlists

-- A region opens when enough people are waiting for it. That makes the waitlist
-- not an administrative tool but the lever for the density without which a
-- geographic title means nothing.
ALTER TABLE regions ADD COLUMN unlock_threshold INTEGER NOT NULL DEFAULT 0;

CREATE TABLE region_waitlist (
  player_id   TEXT NOT NULL REFERENCES players(id),
  region_id   TEXT NOT NULL REFERENCES regions(id),
  app_id      TEXT REFERENCES apps(id),
  joined_at   TEXT NOT NULL,
  notified_at TEXT,
  PRIMARY KEY (player_id, region_id)
);
CREATE INDEX region_waitlist_region_idx ON region_waitlist(region_id);
