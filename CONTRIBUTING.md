# Contributing

This is a small project with a clear shape. The fastest way to get a change
merged is to keep it in that shape.

## Getting started

```bash
npm install
npm test          # everything: unit + integration + coverage + live smoke
npm run dev       # local worker on :8799
```

`npm test` resets a local D1, applies the migrations, boots a real worker and
runs every suite against it. If it is green on your machine it is green in CI.

It needs nothing from you first: a missing `.dev.vars` is created from
`.dev.vars.example`, whose values are development placeholders and belong on no
deployed instance. Real secrets are set with `wrangler secret put NAME` and are
deliberately absent from `wrangler.jsonc`, because a plain-text var of the same
name wins over a secret on every deploy.

The worker binds port 8799. If something else on your machine holds it, pass
another: `PORT=8822 npm test`.

## The rules this codebase lives by

1. **The ledger is the truth.** Leaderboards, qualifications, streaks, badges,
   ratings and titles are *derived*. If you find yourself storing a derived
   value that cannot be recomputed from `entries`, stop and think again.
2. **A title never reaches higher than its discipline's trust tier.** Tier 0
   awards nothing, tier 1 reaches city level at most. This is enforced in code
   and it is not a suggestion.
3. **Only the public key belongs in a client.** Anything that carries authority
   — creating disciplines, reporting duels, granting collectibles — requires the
   secret key and therefore a server.
4. **Blocks never change results.** A block cuts contact, not leaderboards.
   Otherwise the same standing would have different truths per viewer.
5. **Nothing personal that we do not need.** No email, no IP in the database,
   nothing finer than a district. If your change stores more, it needs a reason
   in the pull request.

## Tests

Every behavioural change needs a test. We measure coverage and enforce
thresholds (`vitest.config.ts`); a drop fails the run.

- Tests run inside the real Workers runtime against a real D1, not against
  mocks. Use `tests/helpers.ts`.
- **State persists between tests in one file.** Use `freshSeason()` and unique
  slugs (`unique('d')`) rather than assuming an empty database.
- Prefer a test that could actually fail. A test asserting `status === 200` on
  something that always returns 200 is worse than no test, because it looks
  like coverage.

## Style

- German is fine in issues and discussions. The code, comments, tests and docs
  are English.
- Comments explain *why*, not *what*. If a line needs a comment to say what it
  does, rewrite the line.
- No dependencies without a reason you can state in one sentence.

## Pull requests

Keep them small and describe the behaviour change in plain words. If you found
a bug, the pull request should contain the test that fails without your fix.
