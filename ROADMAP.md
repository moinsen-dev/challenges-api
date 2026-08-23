# Roadmap

The north star: **be the competition layer small teams reach for**, not because
we outspend anyone, but through care for detail, closeness to the people using
it, and pricing nobody can undercut without losing money.

What follows is honest about order. Everything above the line is built and
tested; everything below is not, and the phases are sequenced by what blocks
what — not by what is fun to build.

## Built

Identity across apps · four aggregations (`best` / `sum` / `count` / `streak`) ·
qualifications · regional leaderboards over a region tree · asynchronous
challenges · head-to-head matches with Glicko-2 · geographic titles with
minimum contenders and unique-winner rules · badges with a composable rule
engine · collections · daily seeds · event stream · profiles · rivals and a
friends leaderboard · blocks · reports and moderation · invites · waitlists
that open a region by themselves · GDPR export and deletion · retention limits ·
developer accounts with GitHub and email-link sign-in · API keys as first-class
objects with rotation, expiry, revocation and last-used · self-service app
creation · an audit trail · tournaments · ghosts · title cards · an OpenAPI
description checked against the router · 443 tests at 97 % statement coverage.

---

## Phase 1 — Actually online ✅

Done on 2026-08-22. The live smoke test passes against the public URL.

- Remote D1 in the EU (WEUR), worker deployed, admin key as a secret.
- Custom domains: `challenges.moinsen.dev` (site), `challenges-api.moinsen.dev` (API).
- Cron trigger: retention sweep daily at 03:17 UTC.
- Static site and dashboard on Cloudflare Pages.

- Migrations run through `wrangler d1 migrations apply`, locally and remotely,
  tracked in a `d1_migrations` table.
- Sign-in is restricted by `DEV_ALLOWLIST`, checked against verified addresses
  only.

One thing carried over, because it is not ours to decide alone:

- **Bot Fight Mode on the zone challenges every non-browser request**, which
  makes a branded API hostname unusable for game clients. Clients use the
  unchallenged `workers.dev` hostname until that zone-wide setting is resolved.

Season close stays manual on purpose: it awards permanent titles, and the first
few should be watched by a person.

## Phase 1b — The rest of the key story

Sign-in and key lifecycle are built. Three pieces need someone outside us:

- **Register the key prefixes with GitHub secret scanning.** `chapi_sk_` is
  deliberately distinctive so a leaked key can be recognised in a public
  repository. GitHub notifies partners; we then revoke automatically and tell
  the owner. This is the single highest-value security feature we can ship,
  and it costs an application form rather than a sprint.
- **Scoped keys** — a key that may submit entries but not create disciplines.

**Done when** a key pushed to a public repository is dead before anyone reads it.

## Phase 2 — SDKs, so integrating takes five minutes

Four clients are built and tested end to end against a real instance:

- **JavaScript/TypeScript** — browser, Worker and Node, typed throughout.
- **Godot 4** — GDScript addon, verified headless in CI-style runs.
- **Dart/Flutter** — sends `occurred_at` with its local offset, which is the
  single most common thing habit apps get wrong.
- **Drop-in widget** — one `<script>` tag, shadow DOM, no build step.

All four refuse a `chapi_sk_` key outright, because a secret key in a client is
a mistake that ships to every device.

Since 2026-08-23 the ladder also has a geography: `/v1/regions/resolve` turns a
position into a district, Germany is imported down to its 400 districts, and
everything outside Hamburg is closed until eleven people wait for it. Before
that a client had to know a district id in order to pick one, and the only ids
that existed were seven Hamburg districts — which made an honest integration
outside this city impossible.

What remains before this phase closes:

- Publish to npm, the Godot Asset Library and pub.dev under stable names.
- Two of our own games wired end to end, in public, as the reference.

**Done when** somebody who is not us integrates without asking a question.

## Phase 3 — An identity that survives a lost phone ✅

- **Passkeys** on top of the anonymous account: register, list, remove, and
  sign in on a device that never held a token. Real signature verification —
  ceremony type, challenge, origin, RP id hash, user presence, the signature
  itself, and the clone-detecting counter.
- **Sessions are visible** to the player, and every other one can be ended from
  the device still in their hand.
- **An optional rescue address.** Unconfirmed addresses can never recover
  anything, one address rescues at most one account, and recovering ends every
  other session.

A passkey is a public key and an opaque id, so the promise that an account
needs no personal data survives intact.

**Done:** a player can move to a new phone with no support contact.

## Phase 4 — A read path that survives a real population ✅

- **Materialised standings** per competition key, with the region chain
  denormalised so a board at any level is an index range rather than a
  recursive walk.
- **Rank by counting, not sorting** — how many stand ahead of you.
- **Neighbourhood** (`/around`), which is what a game actually shows.
- **Cursor paging** on leaderboards; deep pages cost what the first one costs.
- **A load test in the suite.** At 20,000 players: first page 4 ms, ninth page
  2 ms, rank 4 → 4 ms, rank 19,997 → 5 ms, district board 3 ms, neighbourhood
  8 ms. The test fails if position starts deciding cost again.

The projection is derived and never authoritative: a rebuild endpoint
recomputes it from the ledger, and a test proves the rebuilt result equals the
incrementally maintained one — including for lower-is-better disciplines.

**Done:** a district with a hundred thousand entries answers like one with ten.

## Phase 5 — Live

- **SSE** on the event stream, replacing polling.
- **Presence** and a **matchmaking queue** with parties and region hints.
- Server-issued **join tickets** so a match server can trust who joined.
- Signed **webhooks** with retries, for backends that would rather be told.

**Done when** two strangers in one city get matched and play without either
client claiming a result.

## Phase 6 — Verification: the part nobody copies in a weekend ✅

- Developers upload the deterministic core of their simulation as a **WASM
  module**. A module that **imports anything** is refused at upload — imports
  are how nondeterminism gets in, so refusing them makes determinism checkable
  rather than hopeful.
- A player submits the **input trace** with the run. The entry is held, not
  counted, until somebody has re-simulated it.
- The **verifier** writes the trace into the module's memory, calls the entry
  point in a worker thread that can be killed mid-instruction, and compares.
  Agreement counts; disagreement is rejected with both numbers recorded.
- **Metered per verified run**, in CPU milliseconds, because that is the real
  cost.
- Every leaderboard says which world it is in: `verification: "replay"` or
  `"none"`.

**Where it runs is a finding, not a preference.** Cloudflare refuses to compile
WebAssembly at runtime, and that refusal is correct — a request handler should
not be an execution engine. So the API owns the queue and the verdicts, and the
verifier is a separate process anyone can run. The end-to-end test drives the
real one: an honest run is verified, a claimed score the trace does not produce
is rejected with both numbers, and a module that never returns is stopped by
the timeout.

**Done:** a tier-1 discipline can prove a run instead of trusting it.

## Phase 7 — Ceremony, because a title needs a moment

- Tournaments: brackets, swiss, scheduled finals.
- Replays and **ghosts**, so you can race the district champion while they sleep.
- Season ceremony, permanent title archive, shareable images per title.
- City clubs and team standings aggregated from individual results.

**Done when** winning a district title produces something a person wants to post.

## Phase 8 — Community surface

The surface is built and live:

- **OpenAPI 3.1** at `/v1/openapi.json`, 124 operations across 12 tags. It is
  generated from a catalogue that a test compares against the router itself, so
  the build fails if the description ever gains an endpoint the service does not
  have, or loses one it does. That test caught two undocumented routes on the
  day it was written.
- **A live console in the docs**, running against a published sandbox app on the
  production instance with a real public key: create an account, pick a district,
  submit a score, read the board, find yourself on it, delete the account again.
  Every request is shown exactly as it goes out.
- **A status page** that asks the running service, not a dashboard: database and
  blob latency, queue depths, the open season.
- **A public changelog**, written in the same voice as everything else.
- **A Hamburg page**, because the rollout is city by city: density beats reach,
  and the waitlist mechanism already exists for exactly this.

What remains before this phase closes:

- A place to talk that we actually read — a repository is not a community.
- The first city final, with real humans in one room.

**Done when** the first city final happens with real humans in one room.

## Phase 9 — Billing, and not a day earlier

Free stays free: one app, leaderboards, qualifications, challenges, badges,
collections, titles up to city level, 100,000 entries a month. Metering,
invoicing and quotas get built when an outside developer actually needs them —
not to have a pricing page.

**Done when** somebody outside pays for verification or a world-level title.

---

## What will never be built here

Inventory and in-game currency, cloud saves, player storage, remote config and
feature flags, analytics, push delivery — and **no chat**.

Chat is where a small competition layer turns into a moderation company. What
exists here is challenges, rivals and reports; conversations belong in the app.

Every one of these is a place where the big platforms became large, expensive
and slow. Staying out of them is the plan, not an oversight.
