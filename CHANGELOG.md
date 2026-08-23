# Changelog

Dates are when the work landed. Versions follow the phases in
[`ROADMAP.md`](ROADMAP.md); the API itself is `/v1` throughout and no published
endpoint has changed shape.

## 2026-08-23

### Geography, so that a district is a place — phase 2b

- **`GET /v1/regions/resolve?lat=&lon=`** answers with the district a position
  is in, its chain up to the world, and — when the district is closed — how many
  people are still missing before it opens. The position is used and discarded:
  it is never written to the database, never logged, never tied to an account,
  and the call needs no player at all.
- **Germany is imported**: 16 Bundeslaender and all 400 districts, with real
  boundaries, plus the seven districts of Hamburg. Everything outside Hamburg
  arrives **closed**, with a threshold of eleven. That is not caution. The
  waitlist that opens a region by itself has existed since phase 5 and had
  nothing to wait for — there were twelve hand-typed rows in the whole world,
  and a client had to know a district id before it could pick one.
- Boundaries are **not committed**. `scripts/geo-import.mjs` fetches them from
  Eurostat GISCO (NUTS 2024, © EuroGeographics) and OpenStreetMap (ODbL) and
  emits SQL, which keeps this repository CC0 and free of 1.8 MB of polygons.
- **A home region is now the finest open region at that place**, not literally
  level 1. Outside Hamburg the districts below a rural county do not exist yet,
  and the old rule left everyone there with nowhere to live.
- `GET /v1/waitlist` is capped and reports a total. It used to return everything
  closed, which was nothing before this and four hundred regions after it.
- The console in the docs asks the browser where it is instead of offering the
  one district it knew.

Two things were measured rather than assumed, and both were wrong on the first
attempt. Ordering candidate regions by the size of their bounding box resolves
the Hamburg town hall to Hamburg rather than to Hamburg-Mitte, because that
district reaches out to Neuwerk in the North Sea and its box is therefore wider
than the city's; the fix is to order **rings**, which have no exclaves. And
Berlin resolved to its Bundesland rather than to its district, because a city
state is one boundary filed twice with a box identical to the last decimal.

## 2026-08-22

Everything below happened on one day, which is why the entries read as phases
rather than as releases.

### Community surface — phase 8

- **OpenAPI 3.1** at `/v1/openapi.json`, 124 operations across 12 tags,
  generated from a catalogue that a test compares against the router in both
  directions — a described endpoint that does not exist fails the build, and so
  does an endpoint nobody described.
- **A console in the docs** that runs against a sandbox app on the live
  instance: account, district, entry, board, your own rank, deletion. Its public
  key sits visibly in the page source, which is the point of a public key.
- **A status page** that asks `/v1/health` rather than a dashboard, and a
  **Hamburg page**, because the rollout goes city by city.
- This changelog.

### Ceremony — phase 7

- **Tournaments**, single elimination, seeded from the standings rather than
  from the sign-up order. Byes go to the top seeds.
- **Ghosts**: the runs at the top of a board, with the input trace each was
  made of, so a player can race the district champion while they sleep.
- **Title archive** and a **shareable SVG card** per title, public so it can be
  embedded anywhere.
- Fixed: `rank()` gave a player a rank on a board they were not on, which once
  handed a regional top seed to somebody from another district.

### Verification — phase 6

- Developers upload the deterministic core of their simulation as a **WASM
  module**. A module that **imports anything** is refused, which makes
  determinism checkable rather than hopeful.
- Runs are held until re-simulated from their trace; only agreement counts.
- Metered in CPU milliseconds.
- The verifier runs outside the Worker, because Cloudflare refuses to compile
  WebAssembly at runtime — and that refusal is correct.

### Live — phase 5

- **SSE** on the event stream, resumable from `Last-Event-ID`.
- **Presence**: a count of everyone, names only for your own rivals.
- **Matchmaking** that never hands the same player to two matches.
- **Join tickets**, HMAC-signed, verifiable by a match server offline.
- **Signed webhooks** with backoff, cron-driven retries and a visible
  `failed` state.

### Scale — phase 4

- **Materialised standings**: rank by counting who is ahead rather than by
  sorting the board. At 20,000 players, rank 19,997 answers as fast as rank 4.
- **Cursor paging** and a **neighbourhood** endpoint.
- Fixed: a held entry that was later accepted never triggered the exam, so a
  player whose only run went through review could never appear on a board.

### Recovery — phase 3

- **Passkeys** with real signature verification: ceremony type, challenge,
  origin, RP id hash, user presence, the signature, and the clone-detecting
  counter.
- **Visible sessions**, and a way to end all the others.
- An **optional rescue address**. Unconfirmed addresses recover nothing.

### Clients — phase 2

- **JavaScript/TypeScript**, **Godot 4** and **Dart/Flutter** clients, plus a
  **drop-in leaderboard** that needs one script tag.
- All four refuse a secret key outright.

### Security and access — phase 1b

- **Sign in with GitHub or an emailed link** for developers.
- **API keys as objects**: rotation without a gap, expiry, revocation, last
  use — and a refusal to revoke the last live key of a kind.
- `DEV_ALLOWLIST`, checked against verified addresses only.

### Online — phase 1

- Deployed: D1 in the EU, custom domains, a daily retention cron.
- Fixed before anybody noticed: a plain-text var in the config silently
  replaced the real admin key on deploy.

### Before that

The competition layer itself: identity across apps, four aggregations,
qualifications, regional leaderboards, challenges, Glicko-2, geographic titles,
badges, collections, daily seeds, profiles, rivals, blocks, moderation,
invites, self-opening waitlists, GDPR export and deletion, retention limits.
