-- Ceremony: tournaments, ghosts and a title that can be shown
--
-- A season that simply ends is a season nobody remembers. Three things make
-- the difference, and one of them is nearly free:
--
--   * Ghosts. Verified runs already carry the input trace that produced them.
--     Racing the district champion while they sleep is therefore not a new
--     system, it is an endpoint over data phase 6 already stores.
--   * Tournaments. A ladder answers "who is best on average". A bracket
--     answers "who won, on the day, in front of people" — which is the part
--     somebody tells their friends about.
--   * A title somebody can show. A row in a database is not a trophy.

-- format: 'single_elimination' — swiss and round robin are deliberately absent
-- until somebody needs them; see ROADMAP.md.
-- state:  'open' | 'running' | 'finished' | 'cancelled'
CREATE TABLE tournaments (
  id             TEXT PRIMARY KEY,
  app_id         TEXT NOT NULL REFERENCES apps(id),
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  format         TEXT NOT NULL DEFAULT 'single_elimination',
  state          TEXT NOT NULL DEFAULT 'open',
  region_id      TEXT REFERENCES regions(id),
  max_entrants   INTEGER NOT NULL DEFAULT 32,
  starts_at      TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  champion_id    TEXT REFERENCES players(id),
  UNIQUE (app_id, slug)
);

CREATE TABLE tournament_entrants (
  tournament_id  TEXT NOT NULL REFERENCES tournaments(id),
  player_id      TEXT NOT NULL REFERENCES players(id),
  seed           INTEGER,
  state          TEXT NOT NULL DEFAULT 'in',
  joined_at      TEXT NOT NULL,
  PRIMARY KEY (tournament_id, player_id)
);

-- A slot exists before the players who fill it do. `round` counts from 1, and
-- `slot` is the position inside that round, so the whole bracket can be drawn
-- from this table alone.
CREATE TABLE tournament_matches (
  id             TEXT PRIMARY KEY,
  tournament_id  TEXT NOT NULL REFERENCES tournaments(id),
  round          INTEGER NOT NULL,
  slot           INTEGER NOT NULL,
  player_a       TEXT REFERENCES players(id),
  player_b       TEXT REFERENCES players(id),
  winner_id      TEXT REFERENCES players(id),
  state          TEXT NOT NULL DEFAULT 'pending',
  reported_at    TEXT,
  detail         TEXT,
  UNIQUE (tournament_id, round, slot)
);
CREATE INDEX tournament_matches_idx ON tournament_matches(tournament_id, round, slot);

-- A title people can look at, rather than a row people are told about.
ALTER TABLE titles ADD COLUMN tournament_id TEXT REFERENCES tournaments(id);
