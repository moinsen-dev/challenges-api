# Drop-in leaderboard

One script tag, no build step, no dependencies, no account needed to look at it.

```html
<script src="https://challenges.moinsen.dev/embed/leaderboard.js"
        data-key="chapi_pk_…"
        data-discipline="score-attack"
        data-region="hh-eimsbuettel"
        data-highlight="kirsten"
        data-limit="10"></script>
```

The board renders where the tag sits.

| attribute | meaning |
|---|---|
| `data-key` | the **public** key; a `chapi_sk_` key is refused with a visible message |
| `data-discipline` | which discipline to show |
| `data-region` | a region id; omit for the global board |
| `data-limit` | rows, up to 50 (default 10) |
| `data-highlight` | a handle to mark as "you" |
| `data-base` | the API origin, for self-hosted instances |

## Why it behaves

- Everything renders inside a **shadow root**, so the host page's CSS cannot
  break it and it cannot break the host page.
- Light and dark follow `prefers-color-scheme`.
- Failure is visible and contained: a wrong key, an unknown discipline or an
  unreachable API render a short message instead of throwing into the page.
- An empty board says "Nobody has qualified yet. Be the first." rather than
  showing nothing.
- The footer states the contender count and whether a title can be won here at
  all — the same honesty the API answers with.

## Licence

CC0-1.0.
