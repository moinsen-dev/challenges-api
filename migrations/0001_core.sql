-- Challenges API — core schema v1
--
-- Domain neutral: an "app" is a game, a habit tracker or a collector app.
-- A "discipline" is anything measurable and rankable — a high score, minutes
-- meditated, pages read, cards found.
--
-- The entry ledger is the single source of truth. Leaderboards, qualifications,
-- streaks, badges, ratings and titles are derived from it and may be recomputed
-- at any time.
--
-- This file only creates. It deliberately contains NO "DROP TABLE": a migration
-- that opens with two dozen drops is a loaded gun pointed at the production
-- database. Use `npm run db:reset` to reset locally, which deletes the local
-- state directory.

-- ------------------------------------------------------------------- Tenants

-- Keys live in `api_keys` (migration 0004), not here, because a key has a life:
-- it is created, used, rotated and revoked. Two kinds with different authority:
--   public  may live in a client: account, catalog, entry, leaderboard.
--   secret  stays on a server: disciplines, matches, tier-2 authority,
--           granting collectibles, closing a season.
CREATE TABLE apps (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- aggregation  'best'   best single value      (high score, best time)
--              'sum'    sum of all entries     (minutes, kilometres, pages)
--              'count'  number of entries      (sessions, check-ins)
--              'streak' longest daily streak  (habit trackers)
-- score_direction applies to 'best'; for sum/count/streak more is always better.
-- qualifying_score is checked against the AGGREGATE, not against a single entry.
CREATE TABLE disciplines (
  id                 TEXT PRIMARY KEY,
  app_id             TEXT NOT NULL REFERENCES apps(id),
  slug               TEXT NOT NULL,
  name               TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT 'general',
  unit               TEXT,
  aggregation        TEXT NOT NULL DEFAULT 'best',
  score_direction    TEXT NOT NULL DEFAULT 'desc',
  trust_tier         INTEGER NOT NULL DEFAULT 0,
  qualifying_score   REAL,
  max_title_level    INTEGER NOT NULL DEFAULT 0,
  title_min_players  INTEGER NOT NULL DEFAULT 5,
  head_to_head       INTEGER NOT NULL DEFAULT 0,
  max_value          REAL,
  created_at         TEXT NOT NULL,
  UNIQUE (app_id, slug)
);

-- ------------------------------------------------------------------- Players

-- One identity across every app on the platform.
CREATE TABLE players (
  id          TEXT PRIMARY KEY,
  handle      TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id),
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE INDEX sessions_player_idx ON sessions(player_id);

CREATE TABLE player_apps (
  player_id   TEXT NOT NULL REFERENCES players(id),
  app_id      TEXT NOT NULL REFERENCES apps(id),
  first_seen  TEXT NOT NULL,
  PRIMARY KEY (player_id, app_id)
);

-- -------------------------------------------------------- Regions & seasons

-- level: 1 district | 2 city | 3 state | 4 country | 5 continent | 6 world
CREATE TABLE regions (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES regions(id),
  level      INTEGER NOT NULL,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX regions_parent_idx ON regions(parent_id);

CREATE TABLE seasons (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE player_regions (
  player_id  TEXT NOT NULL REFERENCES players(id),
  season_id  TEXT NOT NULL REFERENCES seasons(id),
  region_id  TEXT NOT NULL REFERENCES regions(id),
  locked_at  TEXT NOT NULL,
  PRIMARY KEY (player_id, season_id)
);

-- -------------------------------------------------------------------- Ledger

-- day  the entry's day slice (YYYY-MM-DD), derived from occurred_at. Carries
--      streaks and daily goals without a client having to compute anything.
CREATE TABLE entries (
  id             TEXT PRIMARY KEY,
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  player_id      TEXT NOT NULL REFERENCES players(id),
  region_id      TEXT REFERENCES regions(id),
  value          REAL NOT NULL,
  day            TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  trust_tier     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'counted',
  meta           TEXT,
  idem_key       TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX entries_idem_idx ON entries(discipline_id, player_id, idem_key)
  WHERE idem_key IS NOT NULL;
CREATE INDEX entries_board_idx ON entries(discipline_id, season_id, status);
CREATE INDEX entries_player_idx ON entries(player_id, discipline_id, day);

-- Passed exam. Only who appears here shows up on a leaderboard.
CREATE TABLE qualifications (
  player_id      TEXT NOT NULL REFERENCES players(id),
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  value_at       REAL NOT NULL,
  achieved_at    TEXT NOT NULL,
  PRIMARY KEY (player_id, discipline_id, season_id)
);

-- ---------------------------------------------------------------- Challenges

CREATE TABLE challenges (
  id             TEXT PRIMARY KEY,
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  ranked         INTEGER NOT NULL DEFAULT 0,
  challenger_id  TEXT NOT NULL REFERENCES players(id),
  opponent_id    TEXT REFERENCES players(id),
  target_value   REAL NOT NULL,
  state          TEXT NOT NULL DEFAULT 'open',
  winner_id      TEXT REFERENCES players(id),
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  settled_at     TEXT
);
CREATE INDEX challenges_opponent_idx ON challenges(opponent_id, state);
CREATE INDEX challenges_challenger_idx ON challenges(challenger_id, state);

CREATE TABLE challenge_entries (
  challenge_id  TEXT NOT NULL REFERENCES challenges(id),
  player_id     TEXT NOT NULL REFERENCES players(id),
  entry_id      TEXT REFERENCES entries(id),
  value         REAL,
  entered_at    TEXT NOT NULL,
  PRIMARY KEY (challenge_id, player_id)
);

-- ------------------------------------------------- Head-to-head duels & rating

-- Submittable with the secret key only: a duel needs an authority that does
-- not run inside the player's browser.
CREATE TABLE matches (
  id             TEXT PRIMARY KEY,
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  trust_tier     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'counted',
  challenge_id   TEXT REFERENCES challenges(id),
  meta           TEXT,
  idem_key       TEXT UNIQUE,
  created_at     TEXT NOT NULL
);

CREATE TABLE match_placements (
  match_id   TEXT NOT NULL REFERENCES matches(id),
  player_id  TEXT NOT NULL REFERENCES players(id),
  placement  INTEGER NOT NULL,
  value      REAL,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX match_placements_player_idx ON match_placements(player_id);

-- Glicko-2, separate per season and discipline. Raw ratings from different
-- disciplines are never added together.
CREATE TABLE ratings (
  player_id      TEXT NOT NULL REFERENCES players(id),
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  rating         REAL NOT NULL DEFAULT 1500,
  rd             REAL NOT NULL DEFAULT 350,
  volatility     REAL NOT NULL DEFAULT 0.06,
  matches        INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (player_id, discipline_id, season_id)
);

-- -------------------------------------------------------------------- Titles

CREATE TABLE titles (
  id             TEXT PRIMARY KEY,
  player_id      TEXT NOT NULL REFERENCES players(id),
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  region_id      TEXT NOT NULL REFERENCES regions(id),
  level          INTEGER NOT NULL,
  value_at       REAL NOT NULL,
  contenders     INTEGER NOT NULL,
  awarded_at     TEXT NOT NULL,
  UNIQUE (discipline_id, season_id, region_id)
);
CREATE INDEX titles_player_idx ON titles(player_id);

-- ------------------------------------------------------------------- Badges

-- app_id NULL = platform-wide badge (that is the whole point).
-- rule = JSON evaluated against the ledger. Always cosmetic, never an advantage.
CREATE TABLE badges (
  id           TEXT PRIMARY KEY,
  app_id       TEXT REFERENCES apps(id),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  rule         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE player_badges (
  player_id  TEXT NOT NULL REFERENCES players(id),
  badge_id   TEXT NOT NULL REFERENCES badges(id),
  earned_at  TEXT NOT NULL,
  PRIMARY KEY (player_id, badge_id)
);

-- ------------------------------------------------------------- Collections

CREATE TABLE collections (
  id       TEXT PRIMARY KEY,
  app_id   TEXT NOT NULL REFERENCES apps(id),
  slug     TEXT NOT NULL,
  name     TEXT NOT NULL,
  UNIQUE (app_id, slug)
);

CREATE TABLE collection_items (
  id             TEXT PRIMARY KEY,
  collection_id  TEXT NOT NULL REFERENCES collections(id),
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  rarity         TEXT NOT NULL DEFAULT 'common',
  UNIQUE (collection_id, slug)
);

CREATE TABLE player_items (
  player_id    TEXT NOT NULL REFERENCES players(id),
  item_id      TEXT NOT NULL REFERENCES collection_items(id),
  count        INTEGER NOT NULL DEFAULT 1,
  acquired_at  TEXT NOT NULL,
  PRIMARY KEY (player_id, item_id)
);

-- -------------------------------------------------------------------- Events

-- Append-only. Clients poll with ?since=; SSE will hang off this later.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT REFERENCES apps(id),
  player_id   TEXT REFERENCES players(id),
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX events_player_idx ON events(player_id, id);
CREATE INDEX events_app_idx ON events(app_id, id);

-- One-time code to carry the same identity to a second device or to an app on
-- another domain. Without it, "one identity across all apps" is only a promise,
-- because localStorage is separated per origin.
CREATE TABLE link_codes (
  code_hash   TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
