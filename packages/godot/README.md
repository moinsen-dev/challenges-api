# Challenges API — Godot client

Leaderboards, qualifications, challenges, badges and geographic titles for
Godot 4, from the [Challenges API](https://challenges.moinsen.dev).

Copy `addons/challenges_api` into your project and enable the plugin. The
client is a `class_name`, so no autoload is needed.

```gdscript
var api := ChallengesAPI.new()
api.base_url = "https://challenges-api.moinsen.dev"
api.app_key = "chapi_pk_…"          # only ever the public key
add_child(api)

await api.sign_in()                  # anonymous, token stored in user://
await api.choose_region("hh-eimsbuettel")

var result: Dictionary = await api.submit("score-attack", score)
if result.ok and result.data.qualified_now:
    show_toast("You are on the board!")

var board: Dictionary = await api.leaderboard("score-attack", "hh-eimsbuettel")
for row in board.data.entries:
    print("%d. %s — %s" % [row.rank, row.handle, row.value])
```

## Every call returns the same shape

```gdscript
{ "ok": true, "status": 201, "data": { … }, "error": "" }
```

No exceptions to catch, no half-states. On failure `error` carries the server's
own plain-words message, so it can go straight into a toast.

## Details worth knowing

- **`sign_in()` is idempotent** and repairs itself: a stored token the server no
  longer accepts is dropped and replaced instead of failing forever.
- **`signed_out` signal** fires when a token stops being accepted — hook it up
  to send the player back to a sign-in screen.
- **`request_finished(path, ok)`** is emitted after every call, which is enough
  for a global spinner.
- **A secret key is refused at `_ready()`** with a clear error, because a
  `chapi_sk_` key in a game build is a mistake that ships.
- **The token lives in `user://challenges_token.txt`.** Set `token_path` to ""
  to keep it in memory only.

## Tested

`packages/godot/test` is a headless end-to-end suite against a running
instance. Run it with:

```bash
godot --headless --path packages/godot -- --base=http://127.0.0.1:8799 --key=chapi_pk_…
```

## Licence

CC0-1.0.
