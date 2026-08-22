# challenges_api

Dart and Flutter client for the [Challenges API](https://challenges.moinsen.dev)
— leaderboards, qualifications, challenges, badges and geographic titles.

```dart
final api = ChallengesClient(
  baseUrl: 'https://challenges-api.moinsen.dev',
  appKey: 'chapi_pk_…',        // only ever the public key
  storage: MemoryTokenStore(), // swap for shared_preferences in a real app
);

await api.signIn();
await api.chooseRegion('hh-eimsbuettel');

final result = await api.submit('daily-practice', 1, occurredAt: DateTime.now());
print('${result.streakDays} days in a row');

final board = await api.leaderboard('score-attack', region: 'hh-eimsbuettel');
print(board.titleEligible); // false means this district cannot crown anybody yet
```

## Details worth knowing

- **`occurredAt` is sent with its local offset.** For habit disciplines the day
  slice is read from it, so 23:40 local falls on the right day instead of the
  UTC day after. This is the single most common thing to get wrong.
- **`signIn()` is idempotent** and self-repairing: a token the server no longer
  accepts is cleared and replaced.
- **Errors are `ChallengesException`** with `statusCode`, the API's own
  `message`, the parsed `body`, and `needsSignIn`.
- **`TokenStore` is an interface.** `MemoryTokenStore` ships; back it with
  shared_preferences, the keychain or a file in your app.
- **A `chapi_sk_` key throws on construction.** A secret key in an app is a
  mistake that ships to every device.

## Tested

`packages/dart/test` runs end-to-end against a real instance:

```bash
BASE=http://127.0.0.1:8799 APP_KEY=chapi_pk_… dart test
```

## Licence

CC0-1.0.
