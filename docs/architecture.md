# Architecture

Why the system is shaped the way it is. The endpoint contract lives in
[`api.md`](api.md); this document is about the decisions behind it.

## The thesis

A leaderboard is worthless. A **title** is valuable. The difference is not
technology, it is **credibility** — and credibility has exactly four
infrastructural parts:

1. **Verification** — the number was demonstrably played, not invented.
2. **Scarcity** — seasons end, titles are unique, regions need contenders.
3. **Witness** — the final was scheduled, recorded, public.
4. **Portability** — the title stays with the player, even if the game dies.

None of the four is solved by the usual backends, all four are too expensive
for a small team to build, and every one of them gets better the more apps take
part. That is the whole reason this exists as shared infrastructure.

## The ledger is the truth

`entries` is the only thing that is written as fact. Leaderboards,
qualifications, streaks, badges, ratings and titles are **derived** and may be
recomputed at any time. This is what makes the service operable by one person
for years: if a projection breaks, it is rebuilt, not restored.

The rule has teeth. A banned player is filtered out of standings rather than
deleted, so the ban stays reversible. An entry above a plausibility limit is
held for review rather than dropped, so a mistake is recoverable.

## Domain neutrality is one field

The difference between a high-score game, a running app and a habit tracker is
`disciplines.aggregation`:

| value | a player's value is | typical case |
|---|---|---|
| `best` | the best single entry (direction decides) | high score, best time |
| `sum` | the sum over the season | kilometres, minutes, pages |
| `count` | the number of entries | finds, check-ins, sessions |
| `streak` | the longest run of consecutive days | habits |

Everything else in the system is unchanged. One recursive CTE carries all four.

The subtle consequence: **the qualification bar is checked against the
aggregate**, not against a single entry. For `sum` or `streak` anything else
would be meaningless — and it removes the wart where the qualifying run itself
did not count.

## Qualification as the entrance

A player does not enter the ranked world by signing up, but by passing a
single-player exam. This solves four problems at once:

- **Cold start.** There is a goal before there is an opponent.
- **Sybil resistance.** An exam costs real play, which is the cheapest defence
  the geographic ladder can have.
- **Single-player games get a place.** They can qualify, badge and feed the
  ladder without any multiplayer code.
- **No dead weight.** Someone who never qualified never appears.

## Trust tiers cap the ladder

Most small games have no authoritative server, so a generic service must serve
them without devaluing titles. The answer is a tier per discipline, visible on
every leaderboard, and a hard rule: **a title never reaches higher than the
tier**.

| tier | vouched for by | highest title |
|---|---|---|
| 0 | nobody | none |
| 1 | server re-runs the input trace | city |
| 2 | the app's own signing server | world |
| 3 | a scheduled, recorded final | world |

A tier-0 app gets leaderboards and challenges immediately — and no world
champion. That is both the upgrade path and the honesty.

## Density, not reach

A global ranking needs millions of players to be interesting. A district
ranking needs eleven. That inverts the usual cold-start economics: the scarce
resource is **density in one place**, not reach.

Two mechanisms encode it:

- A region awards a title only with a **minimum number of contenders** and a
  **unique winner**. An embarrassing title is worse than no title.
- A closed region carries an **unlock threshold**; once enough people join its
  waitlist, it opens itself and notifies everyone waiting. The waitlist is not
  administration, it is the growth mechanism.

Home regions are **locked per season**, otherwise everyone moves to the emptiest
district. Nothing finer than a district is ever stored.

## Two keys, because a browser is not an authority

Each app has a public key (`chapi_pk_`) and a secret key (`chapi_sk_`). The public key may
live in a client: accounts, catalog, entries, leaderboards. The secret key
never may: creating disciplines, reporting duels, granting collectibles,
closing seasons. Disciplines at tier 2 and above refuse entries submitted with
the public key.

Only SHA-256 hashes of both keys — and of every player token — are stored. A
database dump grants no access.

## Once a leaderboard is public, people meet

That single fact produces the whole social layer: profiles (a display name
separate from the handle, a featured title), rivals (one-sided follows, no
request inbox), blocks, and reports with moderation.

The load-bearing decision: **a block cuts contact, not results.** No challenge,
no visibility in search, existing rivalries and challenges dissolved — but the
leaderboard is untouched. Otherwise the same standing would have different
truths depending on who is looking, and a block would become a tool for making
inconvenient results disappear.

## Deliberately out of scope

Inventory and currency, cloud saves, player storage, remote config, analytics,
push delivery, chat. Each of these is a place where the large platforms became
large, expensive and slow. Chat in particular is where a small competition
layer turns into a moderation company.

## Stack

Cloudflare Workers for compute at the edge, D1 for the ledger, Hono for routing.
No servers, no maintenance window, cost close to zero per player. Durable
Objects and a WASM verification sandbox are planned where they are actually
needed — see [`../ROADMAP.md`](../ROADMAP.md).
