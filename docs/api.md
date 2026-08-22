# API reference

Everything lives under `/v1`. Responses are JSON; errors carry an `error` field
in plain words.

## Authentication

| Header | Who | What it unlocks |
|---|---|---|
| `X-App-Key: chapi_pk_...` | any client | accounts, catalog, entries, leaderboards, social |
| `X-App-Key: chapi_sk_...` | your server | disciplines, duels, collectibles, invites |
| `Authorization: Bearer ...` | a player | anything tied to a person |
| `X-Admin-Key` | the operator | apps, regions, seasons, moderation, retention |

A player token is **platform-wide**: the same token identifies the same person
in every app. To move an identity to another device or another domain, mint a
one-time code with `POST /v1/me/link-code` and redeem it with
`POST /v1/auth/redeem`.

## Submitting an entry

```http
POST /v1/entries
X-App-Key: chapi_pk_...
Authorization: Bearer ...

{
  "discipline": "kilometres",
  "value": 7.2,
  "occurred_at": "2026-08-22T21:40:00+02:00",
  "idem_key": "run-2026-08-22-a"
}
```

```json
{
  "entry_id": "ent_...",
  "value": 7.2,
  "aggregate": 107.2,
  "aggregation": "sum",
  "qualified": true,
  "qualified_now": false,
  "rank": { "region": { "rank": 2, "of": 9 }, "global": { "rank": 41, "of": 260 } },
  "streak_days": null,
  "settled_challenges": [],
  "badges_earned": []
}
```

**Habit apps, read this:** the day slice comes from `occurred_at`. Send the
timestamp with its local offset and 23:40 local falls on the right day instead
of the UTC day after. Without `occurred_at` the server time in UTC applies.

Returns `202` with `status: "review"` when the value exceeds the discipline's
plausibility limit, `200` with `duplicate: true` when the `idem_key` was already
used, `413` when `meta` exceeds 4 KB.

## Operator — `X-Admin-Key`

| | |
|---|---|
| `POST /v1/admin/apps` | create an app; both keys are shown exactly once |
| `PATCH /v1/admin/apps/:slug` | access mode, invite allowance |
| `GET /v1/admin/apps` · `GET /v1/admin/apps/:slug` | counters, disciplines, activity, review cases |
| `POST /v1/admin/regions` | unlock a region, optionally closed with a threshold |
| `POST /v1/admin/regions/:id/unlock` | open a region and notify its waitlist |
| `GET /v1/admin/regions/density` | contenders per region (`?season=`) |
| `POST /v1/admin/seasons` | create a season |
| `POST /v1/admin/seasons/:id/close` | award titles, open the next (`?dry_run=1`) |
| `GET /v1/admin/seasons` | seasons with entry and title counts |
| `POST /v1/admin/entries/:id/review` | decide a held entry |
| `GET /v1/admin/reports` · `POST /v1/admin/reports/:id/resolve` | moderation queue |
| `POST /v1/admin/players/:handle/status` | active, suspended, banned |
| `POST /v1/admin/badges` | platform-wide badge |
| `GET /v1/admin/events` · `GET /v1/admin/invites` | operational log |
| `POST /v1/admin/maintenance` | retention sweep (`?dry_run=1`) |

## Developer — `X-App-Key: chapi_sk_...`

| | |
|---|---|
| `POST /v1/disciplines` | aggregation, trust tier, exam bar, title reach |
| `POST /v1/badges` | badge scoped to your app |
| `POST /v1/collections` · `/:slug/items` · `/:slug/grant` | collectibles |
| `POST /v1/matches` | duel result with placements; updates Glicko-2 |
| `POST /v1/tournaments` · `POST /v1/tournaments/:slug/start` | create and start a bracket |
| `POST /v1/tournaments/:slug/matches/:id/result` | decide one match |
| `POST /v1/verifier/modules?name=` | upload a `.wasm` module (raw body) |
| `GET /v1/verifier/modules` | what is uploaded, with hashes and exports |
| `POST /v1/disciplines/:slug/verifier` | attach a module, or detach with `{"module": null}` |
| `GET /v1/verifier/usage` | verified runs and CPU time, per day |
| `POST /v1/invites` | invite codes, shown exactly once |
| `GET /v1/signing-secret` | the secret that verifies join tickets and signs webhooks |
| `POST /v1/tickets/verify` | check a join ticket online, if you prefer asking |
| `POST /v1/webhooks` · `GET /v1/webhooks` · `DELETE /v1/webhooks/:id` | endpoints |
| `GET /v1/webhooks/:id/deliveries` | what was sent, what failed, and why |

## Client — `X-App-Key: chapi_pk_...`

| | |
|---|---|
| `POST /v1/auth/anonymous` | account in one call (`invite_code` when closed) |
| `POST /v1/me/link-code` · `POST /v1/auth/redeem` | move the identity |
| `GET /v1/me` · `GET /v1/players/:handle` | own and public profile |
| `GET /v1/me/export` · `DELETE /v1/me` | full export, irreversible deletion |
| `PATCH /v1/me/region` | home district, locked for the season |
| `PATCH /v1/me/profile` · `PATCH /v1/me/handle` | display name, avatar, featured title; handle with a 30-day lock |
| `GET /v1/catalog` | disciplines, regions, season, collections |
| `POST /v1/entries` | submit an entry |
| `GET /v1/disciplines/:d/me` | own value, rank, streak, exam status |
| `GET /v1/leaderboards/:d` | `?region=` `?scope=friends` `?limit=` `?cursor=` |
| `GET /v1/leaderboards/:d/around` | the rows around you (`?region=` `?span=`) |
| `GET /v1/daily/:d` | the day's seed, identical worldwide |
| `POST /v1/challenges` · `/:id/accept` · `GET /v1/challenges` | async challenges |
| `GET /v1/ratings/:d` | rating list |
| `GET /v1/collections/:slug` | a collection with your holdings |
| `POST`/`DELETE /v1/me/follows/:handle` · `GET /v1/me/follows` | rivals |
| `POST`/`DELETE /v1/me/blocks/:handle` · `GET /v1/me/blocks` | blocks |
| `POST /v1/reports` | report a person |
| `POST /v1/waitlist/:region` · `GET /v1/waitlist` | waitlists |
| `POST /v1/me/invites` · `GET /v1/me/invites` | personal invite allowance |
| `GET /v1/entries/:id` | what became of one entry, including a verdict |
| `GET /v1/tournaments` · `GET /v1/tournaments/:slug` | list, and the whole bracket |
| `POST /v1/tournaments/:slug/join` | enter one |
| `GET /v1/ghosts/:d` · `GET /v1/ghosts/trace/:entry` | the runs at the top, and their traces |
| `GET /v1/titles` | the title archive (`?region=` `?season=`) |
| `GET /v1/events?since=` | event stream (cursor based) |
| `GET /v1/events/stream` | the same events as SSE, resumable via `Last-Event-ID` |
| `POST /v1/me/presence` · `GET /v1/presence` | say you are around; read the room |
| `POST /v1/queue` · `GET /v1/queue/:ticket` · `DELETE /v1/queue/:ticket` | matchmaking |
| `POST /v1/me/passkeys/challenge` · `POST /v1/me/passkeys` | add a passkey |
| `GET /v1/me/passkeys` · `DELETE /v1/me/passkeys/:id` | list and remove |
| `POST /v1/auth/passkey/challenge` · `POST /v1/auth/passkey` | sign in on a new device |
| `GET /v1/me/sessions` · `POST /v1/me/sessions/revoke-others` | see and end sessions |
| `POST /v1/me/recovery-email` · `DELETE /v1/me/recovery-email` | optional rescue address |
| `POST /v1/auth/recover` · `GET /v1/auth/recover/callback` | get back in after losing a device |

## Developer console — session cookie

Sign-in authenticates the console, never an API request. A game presents a key
and nothing else, so an outage at the sign-in provider cannot take a game down.

| | |
|---|---|
| `GET /v1/dev/auth/github` | start GitHub sign-in (`?redirect=` to return to your console) |
| `GET /v1/dev/auth/github/callback` | completes it, sets an HttpOnly session cookie |
| `POST /v1/dev/auth/email` | send a magic link and a six-digit code (`{email, redirect?}`) |
| `GET /v1/dev/auth/email/callback` | the link; signs in and redirects |
| `POST /v1/dev/auth/email/verify` | the code, for when the mail opens on another device |
| `POST /v1/dev/logout` | end this session |
| `GET /v1/dev/me` | account, two-factor status, app quota |
| `GET /v1/dev/sessions` · `POST /v1/dev/sessions/revoke-others` | session hygiene |
| `POST /v1/dev/apps` · `GET /v1/dev/apps` | create and list your own apps |
| `GET /v1/dev/apps/:slug/keys` | keys with prefix, name, last used, expiry, revocation |
| `POST /v1/dev/apps/:slug/keys` | mint a key (`kind`, `name`, `expires_in_days`) |
| `POST /v1/dev/keys/:id/revoke` | revoke one, with a reason |
| `GET /v1/dev/audit` | what you did, in order |

An instance can restrict who may sign in with `DEV_ALLOWLIST`
(`@domain`, an exact address, or `github:login`). Empty means open. Only
GitHub-**verified** addresses are considered, and the check runs on every
sign-in.

Rotation is: mint, deploy, revoke. Both keys work in between. Revoking the last
live key of a kind is refused.

Minting a **secret** key asks for a second, recent proof: two-factor at the
provider for a GitHub account, or a sign-in from the last 15 minutes for an
email account. Public keys stay available either way.

The email path answers identically for known and unknown addresses, expires in
15 minutes, works once, invalidates older outstanding links, and kills the code
after five wrong guesses.

## Reading a big board

Leaderboards are served from a materialised projection, one row per player per
competition key. Two consequences you can rely on:

- **Rank costs the same wherever you stand.** It is answered by counting who is
  ahead, from an index — not by sorting the board and looking for you. Measured
  at 20,000 players: rank 4 and rank 19,997 both answer in single-digit
  milliseconds.
- **Paging is by cursor, not by offset.** Pass the `cursor` from a response
  back to get the next page. A cursor stays correct while people below it move,
  and page 400 costs what page 1 costs. The first page numbers its rows; a
  cursor page does not claim positions it did not count.

`GET /v1/leaderboards/:d/around` is what a game usually wants: your rank, the
total, and the handful of rows on either side of you.

The projection is derived, never authoritative. `POST /v1/admin/standings/rebuild`
recomputes it from the ledger, and a test proves the rebuilt result equals the
incrementally maintained one.

## Live

**The stream.** `GET /v1/events/stream` is Server-Sent Events over the same
ledger the polling endpoint reads. It closes itself after a while and says so
(`event: bye`); reconnect with `Last-Event-ID` and nothing is replayed or lost.
Honest about its shape: without a Durable Object nobody can push into that
connection, so the server polls internally — what a client gains is one
connection instead of a timer, and resumption after any drop.

**Matchmaking.** `POST /v1/queue` returns a ticket; poll it until it stops
saying `waiting`. Pairing prefers the closest rating, never pairs a party with
itself, and a ticket nobody claimed expires rather than waiting forever. A
player can hold only one waiting ticket at a time.

**Join tickets.** A matched ticket carries a `join_ticket`: an HMAC-signed
claim that this player belongs in this pairing. Your match server verifies it
with `GET /v1/signing-secret` — offline, no round trip — or asks us with
`POST /v1/tickets/verify` if it would rather. A tampered or expired ticket
fails either way.

**Webhooks.** Signed `t=<unix>,v1=<hex>` over `<t>.<body>`, the shape you
already know. The timestamp is inside the signed payload, so a captured
delivery cannot be replayed the next day; reject anything older than five
minutes. A first attempt is made immediately; failures back off (30 s, 2 min,
10 min, 1 h, 6 h) and are retried by the daily cron. After six attempts a
delivery is marked `failed` and stays visible rather than disappearing.

## Replay verification

A leaderboard is worth what its weakest claim is worth. A discipline can stop
taking claims on trust:

1. Upload the **deterministic core** of your simulation as a WebAssembly
   module. It must **import nothing** — imports are how a clock, a random
   source or a syscall get in, and a module that imports nothing can only
   compute. That is checked at upload, so determinism is a property rather
   than a promise. It must export its `memory` and an entry point, called as
   `verify(ptr: i32, len: i32) -> i64`.
2. Attach it to a discipline.
3. Players then submit `trace` alongside `value`. The entry is stored and held
   (`202`, `verification: "pending"`) — it is not part of the competition yet.
4. A verifier writes the trace into the module's memory, calls the entry point
   under a timeout, and compares the result with the claim. Agreement counts.
   Disagreement is rejected, with both numbers recorded.
5. `GET /v1/entries/:id` tells the player what happened.

Every leaderboard says which of the two worlds it is in: `verification` is
`"replay"` or `"none"`.

**Where it runs.** Not in the Worker. Cloudflare refuses to compile
WebAssembly at runtime — "Wasm code generation disallowed by embedder" — and
that refusal is right: a request handler should not be an execution engine. So
the API owns the queue and the verdicts, and a separate verifier
(`packages/verifier`) claims work, re-simulates it in a worker thread that can
be killed mid-instruction, and reports back. You can run it yourself; the
protocol is three endpoints.

**A verifier that breaks is our problem, not the player's.** An `error` verdict
requeues the job; after three tries the entry waits for a human rather than
counting against anybody.

## Ceremony

**Tournaments** are single elimination. Entrants are **seeded from the
standings**, not from the order people signed up in, so the bracket reflects
the season; the best meets the worst, and when the field is not a power of two
the **byes go to the top seeds**. A match can only be decided once both chairs
are filled, only by one of the two players in it, and only with the secret key.
Winning the final ends the tournament and names a champion.

Swiss and round robin are deliberately absent until somebody needs them.

**Ghosts** are not a new system: a verified run already carries the input trace
that produced it, so `GET /v1/ghosts/:discipline` hands back the runs at the
top of a board together with a link to the bytes each was made of. Only proved
runs have ghosts, which means a ghost is always a run somebody can trust.

**A title somebody can show.** `GET /v1/titles/:id/card.svg` renders a title as
an image — no key needed, because an image nobody can embed is not a shareable
image. It carries the handle, the region, the discipline, the result and the
number of contenders, because a title without a field behind it is worth saying
less about.

## Behaviour worth knowing

- A **challenge** is decided only by performance *after* acceptance. Otherwise
  it would be won by whoever was already better.
- A **region** awards a title only with enough contenders and a unique winner;
  `title_eligible` on every leaderboard says so honestly.
- A **ban** removes a player from leaderboards and profiles but deletes nothing.
- A **block** cuts contact, never results.
- **Retention** is enforced by `POST /v1/admin/maintenance`: link codes after a
  day, events after 180 days, sessions after 730 days of disuse. Entries and
  titles stay until the account is deleted.
