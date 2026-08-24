# CLAUDE.md — Challenges API

Stable facts about this project. Session state lives in `STATE.md` next to this
file; read that one to find out where work stopped.

## What this is

A shared competition layer for many small apps — identity, leaderboards,
qualifications, challenges, badges, collections, Glicko-2 ratings, and
geographic titles from district to world. Domain neutral: a "discipline" is a
high score, kilometres run, mushrooms found or days meditated in a row.

Built because Uli was writing the same backend into every one of his ~14 games.
He is the first customer, not a hypothetical one. The north star, in his words:
outdo every other gaming API **through care for detail, closeness to the people
using it, and pricing nobody can undercut** — not through money.

Public artefacts: `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `docs/`, `legal/`.
`notes/` is German, internal and gitignored.

## Stack and layout

Cloudflare Workers · Hono · D1 (SQLite) · R2. No build step, no bundler config.

| Path | What lives there |
|---|---|
| `src/index.ts` | the Hono app, `/v1/status`, the cron handler. Exports `{fetch, scheduled}` **and** a named `app` — the OpenAPI drift test introspects `app.routes`. |
| `src/lib.ts` | `Env`, the four auth guards (`requireApp`, `requireAppSecret`, `requirePlayer`, `requireAdmin`), key minting, `audit()`, `record()` |
| `src/routes/*.ts` | one module per surface: admin, identity, compete, collect, social, access, developers, recovery, live, hooks, verify, tournaments, ceremony, meta |
| `src/openapi.ts` | `CATALOGUE`, one row per endpoint, and `buildDocument()` |
| `migrations/` | `0001`–`0010`, applied with `wrangler d1 migrations apply` |
| `packages/` | js · godot · dart · widget · verifier (the out-of-Worker replay process) |
| `web/` | the Astro site: landing, docs with a live console, pricing, roadmap, status, changelog, hamburg, dashboard, impressum, datenschutz |
| `notes/` | German working notes — `VISION.md`, `ARCHITECTURE-de.md`, and a long architecture journal that is confusingly also called `STATE.md` |

**Two files named STATE.md.** `./STATE.md` is the session handoff (this
protocol). `notes/STATE.md` is a per-phase German architecture journal that
records *why* each phase was built the way it was. Append to the journal when a
phase closes; rewrite the handoff whenever work stops.

## Commands

```bash
npm test          # the full proof: fresh D1, real worker, vitest + smoke + verifier + SDKs
npm run test:unit # vitest only, with coverage
npm run dev       # local worker on :8799
npm run db:migrate # apply migrations to the REMOTE database
npm run deploy    # wrangler deploy
cd web && npm run build && npx wrangler pages deploy dist --project-name challenges-api
```

## Rules this codebase holds itself to

- **Coverage thresholds are never lowered to make a run pass.** When they break,
  the missing branch gets covered — or the unreachable code gets deleted.
  Two modules shrank that way rather than growing tests for dead paths.
- **Never report a phase done without proof** — a green run, a live response, a
  screenshot. Every phase here was closed against the deployed instance.
- **A ✅ in `ROADMAP.md` means the phase's own "Done when" criterion is met.**
  Several phases are built and still unmarked because their criterion is a
  human event, not a deploy. Do not tidy that away.
- **No migration ever contains `DROP TABLE`.** `npm run db:reset` deletes the
  local state directory instead.
- **`ADMIN_KEY` must not appear in `wrangler.jsonc`.** A plain-text `var` beats a
  secret of the same name on deploy; that once silently replaced the production
  admin key with `dev-admin-key`. The live smoke test caught it.
- The GitHub allowlist reads `/user/emails` and accepts **verified** addresses
  only. `/user.email` is user-editable, so anyone could claim `@moinsen.dev`.

## Things that were measured, not assumed

- **Workers refuse to compile WebAssembly at runtime** (`Wasm code generation
  disallowed by embedder`). That is why the verifier is a separate process. Side
  effect: `wabt` is itself WASM, so test fixtures are precompiled in Node by
  `scripts/build-test-wasm.mjs`.
- **The `moinsen.dev` zone challenges non-browser requests.** Measured again on
  2026-08-24, after a skip rule was added for `challenges-api.moinsen.dev`: a
  human browser passes, and curl, `GodotEngine/4.3` and `Dart/3.13 (dart:io)`
  all still get **403** with `cf-mitigated: challenge`. That is the wrong way
  round for an API — a game is not a browser. So the custom domain may carry
  the console, but **the API endpoint we publish is the `workers.dev` one**,
  which answers 200 to every caller. That is why `workers_dev` stays enabled
  and why `web/src/instance.ts` points where it does. Zone-wide setting, so the
  rest is Uli's call.
- **A browser we drive cannot prove a human is blocked by that challenge.** A
  CDP-driven Chrome sat on the interstitial for 22 seconds while Uli signed in
  through the same host without trouble; Cloudflare sees `navigator.webdriver`.
  Before concluding a challenged host is broken for people, have a person click
  it — the automated result only ever proves the automated case.
- **Godot:** `project.godot` must sit at the project root or headless hangs;
  GDScript cannot infer a type from `await` (`var x := await f()` is a parse
  error); `--import` must run once for `class_name` registration.

## Writing style for anything public

Full sentences, no marketing verbs, no exclamation marks. Say what a thing does
and what it refuses to do. German only in `notes/`, `legal/` and the two legal
pages of the website; everything else is English.
