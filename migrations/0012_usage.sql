-- Counting what the price list says it charges for.
--
-- `usage_counters` has existed since 0009, but only the verifier ever wrote to
-- it. The pricing page named four metered lines and exactly one of them was
-- measurable. You cannot switch on a rate you never counted, and the first
-- customer here is us — so this is the number Uli needs before anybody else
-- does.
--
-- Entries are counted per app per day. There is no index that answers "every
-- entry of this app in this month": entries carry a discipline, not an app,
-- and the existing indexes are built for boards and for one player's history.
CREATE INDEX entries_usage_idx ON entries(discipline_id, day);

-- Which days have already been frozen into usage_counters, per app. A frozen
-- day is never recomputed: deleting an account removes its entries from the
-- ledger, and a bill that shrinks retroactively because somebody exercised
-- their right to erasure is not a bill anybody can reconcile.
--
-- The current day is never frozen. It is derived live from the ledger, which
-- keeps exactly one source of truth per day and no overlap between the two.
CREATE TABLE usage_frozen (
  app_id  TEXT NOT NULL REFERENCES apps(id),
  day     TEXT NOT NULL,
  PRIMARY KEY (app_id, day)
);
