-- Replay verification
--
-- The point of this table set is one sentence: a leaderboard is worth what its
-- weakest claim is worth, and until now every tier-1 claim was taken on trust.
--
-- How it works. A developer uploads the deterministic core of their simulation
-- as a WebAssembly module. A player submits a run together with the input
-- trace that produced it. We re-run the trace against the module and compare
-- the result with what the client claimed. Agreement counts; disagreement does
-- not.
--
-- Why WebAssembly with **no imports at all**: imports are how nondeterminism
-- gets in — a clock, a random source, a syscall. A module that imports nothing
-- can only compute, so the same trace must produce the same answer on our
-- machine as on the player's. Modules with imports are refused at upload,
-- which makes determinism a checkable property rather than a promise.
--
-- Where it runs: not in the Worker. Cloudflare refuses to compile WebAssembly
-- at runtime ("Wasm code generation disallowed by embedder"), and that refusal
-- is correct — it is what stops a request from becoming an execution engine.
-- So the API owns the queue and the verdicts, and a separate verifier claims
-- jobs, runs them under a timeout, and reports back over a signed channel.

CREATE TABLE verifier_modules (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES apps(id),
  name          TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  exports       TEXT NOT NULL,
  memory_pages  INTEGER NOT NULL DEFAULT 16,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  UNIQUE (app_id, name)
);

-- A discipline points at the module that can prove its runs.
ALTER TABLE disciplines ADD COLUMN module_id TEXT REFERENCES verifier_modules(id);
ALTER TABLE disciplines ADD COLUMN verify_export TEXT NOT NULL DEFAULT 'verify';
ALTER TABLE disciplines ADD COLUMN verify_timeout_ms INTEGER NOT NULL DEFAULT 2000;

-- An entry now carries what became of its proof.
--   'none'      nothing was claimed, the discipline does not verify
--   'pending'   a trace is waiting for a verifier
--   'verified'  re-simulation agreed with the claim
--   'failed'    it disagreed, or the module refused the trace
ALTER TABLE entries ADD COLUMN verification TEXT NOT NULL DEFAULT 'none';
ALTER TABLE entries ADD COLUMN trace_sha256 TEXT;

-- state: 'queued' | 'claimed' | 'done' | 'error'
CREATE TABLE verification_jobs (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES apps(id),
  entry_id      TEXT NOT NULL REFERENCES entries(id),
  discipline_id TEXT NOT NULL REFERENCES disciplines(id),
  module_id     TEXT NOT NULL REFERENCES verifier_modules(id),
  claimed_value REAL NOT NULL,
  trace_key     TEXT NOT NULL,
  trace_sha256  TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'queued',
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_by    TEXT,
  claimed_at    TEXT,
  verdict       TEXT,
  computed_value REAL,
  cpu_ms        INTEGER,
  detail        TEXT,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX verification_jobs_queue_idx ON verification_jobs(state, created_at);
CREATE INDEX verification_jobs_entry_idx ON verification_jobs(entry_id);

-- What a verified run costs is real CPU, so it is counted rather than guessed.
CREATE TABLE usage_counters (
  app_id      TEXT NOT NULL REFERENCES apps(id),
  day         TEXT NOT NULL,
  metric      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  cpu_ms      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day, metric)
);
