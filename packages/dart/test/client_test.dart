@TestOn('vm')
library;

import 'dart:io';

import 'package:challenges_api/challenges_api.dart';
import 'package:test/test.dart';

/// End-to-end against a running worker:
///   BASE=http://127.0.0.1:8799 APP_KEY=chapi_pk_... dart test
final base = Platform.environment['BASE'] ?? 'http://127.0.0.1:8799';
final appKey = Platform.environment['APP_KEY'] ?? '';
final discipline = Platform.environment['DISCIPLINE'] ?? 'score-attack';

ChallengesClient newClient() => ChallengesClient(baseUrl: base, appKey: appKey);

String unique(String prefix) =>
    '$prefix-${DateTime.now().microsecondsSinceEpoch}';

void main() {
  setUpAll(() {
    if (appKey.isEmpty) {
      throw StateError('set APP_KEY to a public key of a running instance');
    }
  });

  test('refuses a secret key outright', () {
    expect(
      () => ChallengesClient(baseUrl: base, appKey: 'chapi_sk_${'0' * 64}'),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('signs in and keeps the token', () async {
    final api = newClient();
    final handle = unique('dart');
    final me = await api.signIn(handle: handle);

    expect(me.handle, handle);
    expect(await api.token, isNotNull);

    final again = await api.signIn();
    expect(again.id, me.id);
    api.close();
  });

  test('walks the loop an app actually performs', () async {
    final api = newClient();
    await api.signIn(handle: unique('loop'));
    await api.chooseRegion('hh-altona');

    final weak = await api.submit(discipline, 40);
    expect(weak.qualified, isFalse);

    // A value nobody else in this district will have, so the assertion below
    // does not depend on what other test runs left behind.
    final score = 900000 + DateTime.now().microsecondsSinceEpoch % 90000;
    final passed = await api.submit(discipline, score, meta: {'client': 'dart'});
    expect(passed.qualifiedNow, isTrue);
    expect(passed.regionRank, isNotNull);
    expect(passed.regionRank!.rank, 1);

    final status = await api.status(discipline);
    expect(status.value, score);
    expect(status.qualified, isTrue);

    final board = await api.leaderboard(discipline, region: 'hh-altona');
    expect(board.entries, isNotEmpty);
    expect(board.entries.first.handle, (await api.me()).handle);
    api.close();
  });

  test('honours an idempotency key', () async {
    final api = newClient();
    await api.signIn(handle: unique('idem'));
    final key = unique('run');

    final first = await api.submit(discipline, 777, idemKey: key);
    final second = await api.submit(discipline, 777, idemKey: key);
    expect(second.duplicate, isTrue);
    expect(second.entryId, first.entryId);
    api.close();
  });

  test('sends occurred_at with a local offset', () async {
    final api = newClient();
    await api.signIn(handle: unique('tz'));
    final yesterday = DateTime.now().subtract(const Duration(days: 1));

    final entry = await api.submit(discipline, 123, occurredAt: yesterday);
    expect(entry.entryId, isNotEmpty);

    final exported = await api.exportData();
    final days = (exported['entries'] as List)
        .map((e) => (e as Map<String, dynamic>)['day'] as String)
        .toList();
    // The day slice follows local time, not UTC.
    final expected = yesterday.toIso8601String().split('T').first;
    expect(days, contains(expected));
    api.close();
  });

  test('reads a stable daily seed', () async {
    final api = newClient();
    await api.signIn(handle: unique('seed'));
    final a = await api.daily(discipline);
    final b = await api.daily(discipline);
    expect(a['seed'], b['seed']);
    api.close();
  });

  test('runs a challenge between two clients', () async {
    final challenger = newClient();
    final opponent = newClient();
    await challenger.signIn(handle: unique('a'));
    final other = await opponent.signIn(handle: unique('b'));

    await challenger.submit(discipline, 100);
    final challenge =
        await challenger.challenge(discipline, opponentHandle: other.handle);
    expect(challenge['target_value'], 100);

    await opponent.acceptChallenge(challenge['id'] as String);
    final tooWeak = await opponent.submit(discipline, 50);
    expect(tooWeak.settledChallenges, isEmpty);

    final winning = await opponent.submit(discipline, 150);
    expect(winning.settledChallenges, contains(challenge['id']));

    challenger.close();
    opponent.close();
  });

  test('moves an identity with a link code', () async {
    final phone = newClient();
    final tablet = newClient();
    final me = await phone.signIn(handle: unique('mobile'));
    await phone.submit(discipline, 4242);

    final same = await tablet.redeemLinkCode(await phone.linkCode());
    expect(same.id, me.id);
    expect((await tablet.status(discipline)).value, 4242);

    phone.close();
    tablet.close();
  });

  test('turns an API error into something a caller can act on', () async {
    final api = newClient();
    await api.signIn(handle: unique('err'));

    await expectLater(
      () => api.submit('does-not-exist-here', 1),
      throwsA(
        isA<ChallengesException>()
            .having((e) => e.statusCode, 'statusCode', 404)
            .having((e) => e.message, 'message', 'unknown discipline')
            .having((e) => e.needsSignIn, 'needsSignIn', isFalse),
      ),
    );
    api.close();
  });

  test('forgets a token the server no longer accepts', () async {
    final api = newClient();
    await api.signIn(handle: unique('dead'));
    await api.useToken('0' * 64);

    await expectLater(() => api.me(), throwsA(isA<ChallengesException>()));
    expect(await api.token, isNull);

    final fresh = await api.signIn(handle: unique('fresh'));
    expect(fresh.id, isNotEmpty);
    api.close();
  });

  test('exports and deletes an account', () async {
    final api = newClient();
    await api.signIn(handle: unique('gone'));
    await api.submit(discipline, 9);

    final exported = await api.exportData();
    expect((exported['entries'] as List).length, 1);

    await api.deleteAccount();
    expect(await api.token, isNull);
    api.close();
  });
}
