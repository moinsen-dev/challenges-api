-- Materialised standings
--
-- Until now every leaderboard and every rank was computed by aggregating the
-- whole ledger and then walking the result in memory. Correct, and fine for a
-- thousand players. At a hundred thousand it is a scan per request.
--
-- This table holds one row per player per competition key: their current
-- aggregate, and the region chain it belongs to. It is a projection — it may
-- be dropped and rebuilt from `entries` at any time, and a test proves that
-- the rebuilt result equals the incrementally maintained one.
--
-- The region ancestors are denormalised into one column per level. That looks
-- redundant until you need "rank inside Hamburg" to be an index lookup rather
-- than a recursive walk on every request.
--
--   r1 district · r2 city · r3 state · r4 country · r5 continent · r6 world
--
-- `eligible` folds together the two reasons somebody is absent from a board:
-- they never passed the exam, or they are banned. Keeping it here means a
-- leaderboard never has to join `players` or `qualifications` to be correct.

CREATE TABLE standings (
  discipline_id  TEXT NOT NULL REFERENCES disciplines(id),
  season_id      TEXT NOT NULL REFERENCES seasons(id),
  player_id      TEXT NOT NULL REFERENCES players(id),
  value          REAL NOT NULL,
  since          TEXT NOT NULL,
  eligible       INTEGER NOT NULL DEFAULT 0,
  r1             TEXT,
  r2             TEXT,
  r3             TEXT,
  r4             TEXT,
  r5             TEXT,
  r6             TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (discipline_id, season_id, player_id)
);

-- Global board and global rank.
CREATE INDEX standings_global_idx
  ON standings(discipline_id, season_id, eligible, value, since);

-- One index per region level, so a board at any level is a range scan.
CREATE INDEX standings_r1_idx ON standings(discipline_id, season_id, r1, eligible, value, since);
CREATE INDEX standings_r2_idx ON standings(discipline_id, season_id, r2, eligible, value, since);
CREATE INDEX standings_r3_idx ON standings(discipline_id, season_id, r3, eligible, value, since);
CREATE INDEX standings_r4_idx ON standings(discipline_id, season_id, r4, eligible, value, since);
CREATE INDEX standings_r5_idx ON standings(discipline_id, season_id, r5, eligible, value, since);
CREATE INDEX standings_r6_idx ON standings(discipline_id, season_id, r6, eligible, value, since);

-- Used when a ban or an unban has to touch every board a person is on.
CREATE INDEX standings_player_idx ON standings(player_id);
