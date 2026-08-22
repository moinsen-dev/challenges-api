# @moinsen/challenges

JavaScript and TypeScript client for the [Challenges API](https://challenges.moinsen.dev)
— leaderboards, qualifications, challenges, badges and geographic titles.

Works in a browser, in a Worker and in Node. Typed throughout.

```bash
npm install @moinsen/challenges
```

```ts
import { createClient } from '@moinsen/challenges'

const api = createClient({
  baseUrl: 'https://challenges-api.moinsen.dev',
  appKey: 'chapi_pk_…',        // only ever the public key
})

await api.signIn()                          // anonymous, token remembered
await api.chooseRegion('hh-eimsbuettel')    // locked for the season

const result = await api.submit('score-attack', 12500)
if (result.qualified_now) console.log('You are on the board.')
console.log(result.rank?.region)            // { rank: 3, of: 19, value: 12500 }

const board = await api.leaderboard('score-attack', { region: api.regionId })
```

## What it covers

Entries, leaderboards (regional, global, `scope: 'friends'`), own standing,
daily seeds, challenges, ratings, profile and handle, rivals, blocks, reports,
collections, waitlists, invites, the event stream, data export and deletion.

Anything carrying authority — creating disciplines, reporting duels, granting
collectibles — is a server call and deliberately absent. Passing a `chapi_sk_`
key throws.

## Details worth knowing

- **`signIn()` is idempotent.** With a stored token it returns the existing
  profile instead of creating a second account. `{ force: true }` overrides.
- **A dead token is forgotten.** On any `401` the stored token is cleared, so a
  deleted or banned account cannot put a client in a retry loop.
- **Errors are `ChallengesError`** with `status`, the API's own `message`, the
  parsed `body`, and `needsSignIn`.
- **Storage is pluggable.** `localStorage` when there is one, memory otherwise,
  or bring your own `TokenStore` (keychain, cookie, file).
- **`watchEvents(cb)`** polls the event stream and returns a stop function.
  SSE will replace the polling without changing the signature.
- **`occurredAt` accepts a `Date`.** Send local time for habit disciplines so
  23:40 lands on the right day rather than the UTC day after.

## Licence

CC0-1.0. Take it, change it, ship it.
