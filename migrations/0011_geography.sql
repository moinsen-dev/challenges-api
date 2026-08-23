-- Geography, so that a district is a place and not just a name.
--
-- Until now a region had a name and a parent and nothing else, and the only
-- way for a client to choose one was to already know its id. That made the
-- ladder unusable outside the twelve hand-seeded Hamburg rows, and it left
-- the waitlist in 0003 without any substrate: a region has to exist before
-- anyone can wait for it.
--
-- Coordinates live on the REGION, never on the player. A client sends a
-- position once to /v1/regions/resolve, gets a district back, and only that
-- district id is ever stored. Nothing here records where a person is.

ALTER TABLE regions ADD COLUMN code   TEXT;  -- official key: NUTS id or OSM relation
ALTER TABLE regions ADD COLUMN source TEXT;  -- 'nuts' | 'osm' | 'seed'

CREATE INDEX regions_code_idx ON regions(code);

-- The boundary lives apart from the region row: every existing query joins
-- regions, and none of them wants to drag a polygon along.
--
-- One row per RING, not per region. A region is often several disjoint pieces,
-- and ordering whole regions by their bounding box gets that wrong in a way
-- that is easy to miss: Hamburg-Mitte reaches out to Neuwerk in the North Sea,
-- a hundred kilometres west, so the box around the district is larger than the
-- box around the entire city. Measured on the first import — the town hall
-- resolved to Hamburg instead of Hamburg-Mitte. A ring has no exclaves.
--
-- ring  JSON, [[lon, lat], ...] — an outer ring, simplified at import. Holes
--       are not stored; an enclave resolves correctly because the enclosed
--       region has the smaller ring, which is what the hole would have said.
-- area  bounding-box area of this ring in square degrees. Not a real area,
--       only ever used to order candidates from smallest to largest.
CREATE TABLE region_shapes (
  region_id TEXT    NOT NULL REFERENCES regions(id),
  part      INTEGER NOT NULL,
  min_lat   REAL    NOT NULL,
  min_lon   REAL    NOT NULL,
  max_lat   REAL    NOT NULL,
  max_lon   REAL    NOT NULL,
  area      REAL    NOT NULL,
  ring      TEXT    NOT NULL,
  PRIMARY KEY (region_id, part)
);

-- The candidate scan is a range over latitude; longitude and the ray cast
-- narrow it down afterwards.
CREATE INDEX region_shapes_lat_idx ON region_shapes(min_lat, max_lat);
