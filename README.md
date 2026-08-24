<h1 align="center">Challenges API</h1>

<p align="center">
  <strong>Your players are nobody on a world leaderboard.<br />
  Here they are champion of their neighbourhood.</strong>
</p>

<p align="center">
  A shared competition layer for many small apps: identity, leaderboards,
  qualifications, challenges, badges, collections, ratings — and geographic
  titles, from district to world.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#the-five-rules">The five rules</a> ·
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

Every small game rebuilds the same five things: identity, a leaderboard, a
challenge, a way to find opponents, and something to be proud of. That is
infrastructure, not a game feature — so this is that infrastructure, once,
for all of them.

It is **domain neutral**. A "discipline" is anything measurable: a high score,
kilometres run, mushrooms found, days meditated in a row. Games, habit trackers
and collector apps use the same machine.

**The code is CC0** — public domain as far as law allows. Take it, change it,
sell it, run it yourself. The hosted service is billed by usage, never per user.
The source lives at
[github.com/moinsen-dev/challenges-api](https://github.com/moinsen-dev/challenges-api).

**Live:** the API runs at `https://games-challenges-api.developer-331.workers.dev`
(and `https://challenges-api.moinsen.dev`), the site at
[challenges.moinsen.dev](https://challenges.moinsen.dev). Database in the EU.
The machine-readable description is at
[`/v1/openapi.json`](https://games-challenges-api.developer-331.workers.dev/v1/openapi.json)
— OpenAPI 3.1, and a test fails the build if it ever drifts from the router.
The [docs](https://challenges.moinsen.dev/docs/) carry a console that runs
against a sandbox app on that instance, and the
[status page](https://challenges.moinsen.dev/status/) asks the service itself.

## Quick start

```bash
npm install
npm test          # 462 tests + Godot and Dart client suites in the real Workers runtime + a live smoke test
npm run dev       # local worker on :8799
```

Three lines in a client:

```js
import { createClient } from '@moinsen/challenges'

const api = createClient({ baseUrl, appKey: 'chapi_pk_...' })
await api.signIn()

await api.submit('score-attack', 12500)      // a game
await api.submit('kilometres', 7.2)          // a running app
await api.submit('daily-practice', 1)        // a habit tracker

const board = await api.leaderboard('score-attack', { region: 'hh-eimsbuettel' })
```

## Clients

| | |
|---|---|
| [JavaScript / TypeScript](packages/js) | browser, Worker and Node; typed throughout |
| [Godot 4](packages/godot) | GDScript addon; every call returns `{ok, status, data, error}` |
| [Dart / Flutter](packages/dart) | sends `occurred_at` with its local offset, which habit apps need |
| [Drop-in widget](packages/widget) | one `<script>` tag, shadow DOM, no build step |

All four refuse a secret key outright, and all four are tested end to end
against a real instance — the Godot one headless, the Dart one with `dart test`.

## What it does

| | |
|---|---|
| **One identity** | One anonymous account, valid across every app on the platform. No email required, ever. |
| **Four aggregations** | `best`, `sum`, `count`, `streak` — one field on a discipline decides whether you run a high-score game or a habit tracker. |
| **Qualification as a gate** | A player enters the ranked world by passing a single-player exam. Keeps throwaway accounts and dead weight off the board. |
| **Geographic titles** | District → city → state → country → continent → world. A region only awards a title with enough contenders **and** a unique winner. |
| **Real geography** | `GET /v1/regions/resolve?lat=&lon=` answers with the district a position is in. The position is used and discarded; only the district is ever stored. Germany is imported down to its 400 districts, everything outside Hamburg closed until eleven people wait for it. |
| **Async challenges** | Score attack between two people, decided only by performance after acceptance. No netcode, works for single-player games. |
| **Head-to-head + Glicko-2** | Server-reported duels with a rating tested against Glickman's published reference example. |
| **Badges and collections** | Declarative rules evaluated against the ledger — including rules that span several apps. Always cosmetic. |
| **Daily seed** | One seed per discipline per day, worldwide. Makes single-player runs comparable without anyone being online. |
| **Profiles, rivals, blocks** | Display name, featured title, one-sided follows, a friends leaderboard, and blocks that cut contact without touching results. |
| **Reports and moderation** | A queue, forced rename, timed suspension, reversible ban. Because a public leaderboard with self-chosen names needs it on day one. |
| **Invites and waitlists** | Closed apps, per-player invite allowances, and regions that **open themselves** once enough people are waiting. |
| **Ceremony** | Single-elimination tournaments seeded from the standings, ghosts of verified runs to race against, a title archive, and an SVG card per title that anybody can embed. |
| **Replay verification** | Upload the deterministic core of your simulation as a WASM module that imports nothing; runs are re-simulated from their input trace and only agreement counts. Metered in CPU milliseconds. |
| **Live** | SSE with resumption, presence, a matchmaking queue that never double-books a player, HMAC join tickets a match server verifies offline, and signed webhooks with retries. |
| **A read path that scales** | Materialised standings, rank by counting rather than sorting, cursor paging, and a neighbourhood endpoint. At 20,000 players, rank 19,997 answers as fast as rank 4. |
| **Recovery that stores nothing extra** | Passkeys with real signature verification, visible sessions, and an optional rescue address. Losing a phone no longer loses the titles. |
| **Developer accounts** | Sign in with GitHub or an emailed link, self-service apps, keys with rotation, expiry, revocation and last-used — and sign-in never sits on the request path of the API. The console is served by the API itself at `/dashboard`, because the session is a cookie and a cookie belongs on one origin. |
| **Usage you can check** | Entries per month against the free allowance, verified runs and the CPU they cost, titles above city level. A completed day is frozen once and never recomputed, so erasure cannot rewrite a month that was already reported. Nothing is charged — no rate is switched on. |
| **GDPR built in** | Full export and irreversible deletion as endpoints; retention limits enforced in code, not in a policy document. |

## The five rules

1. **The ledger is the truth.** Everything else is derived and can be recomputed.
2. **A qualification is the entrance.** No exam passed, no place on the board.
3. **A title never reaches higher than its discipline's trust tier.** Tier 0 awards nothing; tier 1 reaches city level at most.
4. **Two keys per app.** `chapi_pk_` may live in a client, `chapi_sk_` never.
5. **A block cuts contact, never results.** Otherwise the same leaderboard would have different truths per viewer.

## Trust tiers

A leaderboard is only worth what its weakest claim is worth, so every
discipline declares who vouches for a result — and the ladder is capped by it.

| Tier | Vouched for by | Highest title |
|---|---|---|
| `0` client | nobody | none |
| `1` replay | server re-runs the input trace | city |
| `2` server | the app's own signing server | world |
| `3` witnessed | a scheduled, recorded final | world |

## Tests

```
Statements   96.9 %      462 tests inside the Workers runtime, against real D1
Branches     88.4 %      plus a live smoke test over HTTP
Functions    96.5 %      coverage thresholds enforced in vitest.config.ts
Lines        99.1 %
```

The tests found the bugs that matter: a race in idempotent submissions, a
migration that opened with two dozen `DROP TABLE`, and a duplicate title event
on a repeated season close.

## Stack

Cloudflare Workers, D1, Hono. No servers to maintain, no maintenance window,
cost close to zero per player. Ratings, titles and leaderboards are derived, so
a rebuild from the ledger is always possible.

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — what is built, what comes next, and what will never be built
- [`docs/architecture.md`](docs/architecture.md) — why the system is shaped this way
- [`docs/api.md`](docs/api.md) — the full endpoint contract
- [`legal/`](legal/) — data inventory, technical measures, processing agreement draft, licence rationale

## Licence

[CC0 1.0 Universal](LICENSE). Rationale — including why "public domain" alone
does not work under German law — in [`legal/LIZENZ.md`](legal/LIZENZ.md).

The boundaries behind `/v1/regions/resolve` are not part of this repository and
carry their own terms. `scripts/geo-import.mjs` fetches them at import time and
writes them straight into the database, which is why nothing here is covered by
anything but CC0:

- Bundesländer and districts: **© EuroGeographics** for the administrative
  boundaries, from [Eurostat GISCO](https://ec.europa.eu/eurostat/web/gisco),
  NUTS 2024. Free to reuse, attribution required.
- The seven districts of Hamburg: **© OpenStreetMap contributors**, available
  under the [Open Database Licence](https://www.openstreetmap.org/copyright).
  Hamburg is one single region at every European level, so its districts have
  no NUTS code and come from OSM instead.
