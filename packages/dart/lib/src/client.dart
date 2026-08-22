import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

/// Client for the Challenges API.
///
/// ```dart
/// final api = ChallengesClient(
///   baseUrl: 'https://challenges-api.moinsen.dev',
///   appKey: 'chapi_pk_...',
/// );
/// await api.signIn();
/// final result = await api.submit('daily-practice', 1);
/// print('${result.streakDays} days in a row');
/// ```
class ChallengesClient {
  ChallengesClient({
    required String baseUrl,
    required this.appKey,
    TokenStore? storage,
    http.Client? httpClient,
  })  : baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl,
        storage = storage ?? MemoryTokenStore(),
        _http = httpClient ?? http.Client() {
    if (appKey.startsWith('chapi_sk_')) {
      throw ArgumentError('a secret key must never be used in an app — pass the public key');
    }
  }

  final String baseUrl;
  final String appKey;
  final TokenStore storage;
  final http.Client _http;

  /// The token in use, or null when signed out.
  Future<String?> get token => storage.read();

  /// Adopt a token minted elsewhere — another device, another app.
  Future<void> useToken(String token) => storage.write(token);

  Future<void> signOut() => storage.clear();

  /// Create an anonymous account, or keep the one already stored.
  Future<Profile> signIn({String? handle, String? inviteCode, bool force = false}) async {
    if (!force && await storage.read() != null) {
      try {
        return await me();
      } on ChallengesException catch (error) {
        if (!error.needsSignIn) rethrow;
        // A token the server no longer accepts is worse than none at all.
        await storage.clear();
      }
    }
    final created = await _call('POST', '/v1/auth/anonymous', body: {
      if (handle != null) 'handle': handle,
      if (inviteCode != null) 'invite_code': inviteCode,
    });
    await storage.write(created['token'] as String);
    return me();
  }

  Future<Profile> me() async => Profile(await _call('GET', '/v1/me'));

  Future<Map<String, dynamic>> catalog() => _call('GET', '/v1/catalog');

  /// The home district. Locked for the rest of the season once chosen.
  Future<Map<String, dynamic>> chooseRegion(String regionId) =>
      _call('PATCH', '/v1/me/region', body: {'region_id': regionId});

  /// Submit one entry.
  ///
  /// Pass [occurredAt] with its local offset for habit disciplines: the day
  /// slice is read from it, so 23:40 local falls on the right day instead of
  /// the UTC day after.
  Future<EntryResult> submit(
    String discipline,
    num value, {
    DateTime? occurredAt,
    Map<String, dynamic>? meta,
    String? idemKey,
  }) async =>
      EntryResult(await _call('POST', '/v1/entries', body: {
        'discipline': discipline,
        'value': value,
        if (occurredAt != null) 'occurred_at': _iso(occurredAt),
        if (meta != null) 'meta': meta,
        if (idemKey != null) 'idem_key': idemKey,
      }));

  Future<DisciplineStatus> status(String discipline) async =>
      DisciplineStatus(await _call('GET', '/v1/disciplines/${Uri.encodeComponent(discipline)}/me'));

  Future<Leaderboard> leaderboard(
    String discipline, {
    String? region,
    String? scope,
    String? cursor,
    int limit = 25,
  }) async =>
      Leaderboard(await _call(
        'GET',
        '/v1/leaderboards/${Uri.encodeComponent(discipline)}'
            '?limit=$limit'
            '${region != null ? '&region=${Uri.encodeComponent(region)}' : ''}'
            '${scope != null ? '&scope=${Uri.encodeComponent(scope)}' : ''}'
            '${cursor != null ? '&cursor=${Uri.encodeComponent(cursor)}' : ''}',
      ));

  /// The rows immediately around the player — what an app actually shows.
  /// Costs the same whether they are 4th or 40,000th.
  Future<Map<String, dynamic>> around(
    String discipline, {
    String? region,
    int span = 2,
  }) =>
      _call(
        'GET',
        '/v1/leaderboards/${Uri.encodeComponent(discipline)}/around'
            '?span=$span'
            '${region != null ? '&region=${Uri.encodeComponent(region)}' : ''}',
      );

  /// The same seed for every player worldwide on a given day.
  Future<Map<String, dynamic>> daily(String discipline) =>
      _call('GET', '/v1/daily/${Uri.encodeComponent(discipline)}');

  Future<Map<String, dynamic>> challenge(String discipline, {String? opponentHandle}) =>
      _call('POST', '/v1/challenges', body: {
        'discipline': discipline,
        if (opponentHandle != null) 'opponent_handle': opponentHandle,
      });

  Future<Map<String, dynamic>> acceptChallenge(String id) =>
      _call('POST', '/v1/challenges/${Uri.encodeComponent(id)}/accept');

  Future<List<Map<String, dynamic>>> challenges() async =>
      ((await _call('GET', '/v1/challenges'))['challenges'] as List).cast<Map<String, dynamic>>();

  Future<Map<String, dynamic>> updateProfile({
    String? displayName,
    String? avatar,
    String? locale,
    String? featuredTitle,
    String? featuredBadge,
  }) =>
      _call('PATCH', '/v1/me/profile', body: {
        if (displayName != null) 'display_name': displayName,
        if (avatar != null) 'avatar': avatar,
        if (locale != null) 'locale': locale,
        if (featuredTitle != null) 'featured_title': featuredTitle,
        if (featuredBadge != null) 'featured_badge': featuredBadge,
      });

  Future<List<Map<String, dynamic>>> events({int since = 0}) async =>
      ((await _call('GET', '/v1/events?since=$since'))['events'] as List).cast<Map<String, dynamic>>();

  /// Tell the platform the player is around. Call every 30–60 seconds.
  Future<Map<String, dynamic>> presence({String status = 'online', String? detail}) =>
      _call('POST', '/v1/me/presence', body: {
        'status': status,
        if (detail != null) 'detail': detail,
      });

  /// A count of everyone online, and names only for the player's own rivals.
  Future<Map<String, dynamic>> whoIsOnline() => _call('GET', '/v1/presence');

  /// Enter matchmaking. Poll [queueState] until it stops saying "waiting".
  Future<Map<String, dynamic>> queueJoin(String discipline, {String? partyId}) =>
      _call('POST', '/v1/queue', body: {
        'discipline': discipline,
        if (partyId != null) 'party_id': partyId,
      });

  /// When matched, the answer carries `join_ticket` — hand it to the match
  /// server, which verifies it offline and never calls us.
  Future<Map<String, dynamic>> queueState(String ticket) =>
      _call('GET', '/v1/queue/${Uri.encodeComponent(ticket)}');

  Future<Map<String, dynamic>> queueLeave(String ticket) =>
      _call('DELETE', '/v1/queue/${Uri.encodeComponent(ticket)}');

  /// The runs at the top of a board, with the trace each was made of — so a
  /// player can race the district champion while they sleep. Verified only.
  Future<Map<String, dynamic>> ghosts(String discipline, {String? region, int limit = 5}) =>
      _call(
        'GET',
        '/v1/ghosts/${Uri.encodeComponent(discipline)}?limit=$limit'
            '${region != null ? '&region=${Uri.encodeComponent(region)}' : ''}',
      );

  /// The whole bracket, drawable from this answer alone.
  Future<Map<String, dynamic>> tournament(String slug) =>
      _call('GET', '/v1/tournaments/${Uri.encodeComponent(slug)}');

  Future<Map<String, dynamic>> joinTournament(String slug) =>
      _call('POST', '/v1/tournaments/${Uri.encodeComponent(slug)}/join');

  /// Titles awarded so far. Each carries an id whose card.svg can be shown.
  Future<Map<String, dynamic>> titles({String? region}) =>
      _call('GET', '/v1/titles${region != null ? '?region=${Uri.encodeComponent(region)}' : ''}');

  /// One-time code to carry this identity to another device or another app.
  Future<String> linkCode() async => (await _call('POST', '/v1/me/link-code'))['code'] as String;

  Future<Profile> redeemLinkCode(String code) async {
    final claimed = await _call('POST', '/v1/auth/redeem', body: {'code': code});
    await storage.write(claimed['token'] as String);
    return me();
  }

  /// Everything stored about this player.
  Future<Map<String, dynamic>> exportData() => _call('GET', '/v1/me/export');

  /// Irreversible. There is no trash bin.
  Future<void> deleteAccount() async {
    await _call('DELETE', '/v1/me');
    await storage.clear();
  }

  void close() => _http.close();

  // -------------------------------------------------------------- internals

  /// Local time with its offset, so a day slice lands on the right day.
  static String _iso(DateTime when) {
    final local = when.toLocal();
    final offset = local.timeZoneOffset;
    final sign = offset.isNegative ? '-' : '+';
    final hours = offset.inHours.abs().toString().padLeft(2, '0');
    final minutes = (offset.inMinutes.abs() % 60).toString().padLeft(2, '0');
    final stamp = local.toIso8601String().split('.').first;
    return '$stamp$sign$hours:$minutes';
  }

  Future<Map<String, dynamic>> _call(String method, String path, {Object? body}) async {
    final token = await storage.read();
    final request = http.Request(method, Uri.parse('$baseUrl$path'))
      ..headers['Content-Type'] = 'application/json'
      ..headers['X-App-Key'] = appKey;
    if (token != null) request.headers['Authorization'] = 'Bearer $token';
    if (body != null) request.body = jsonEncode(body);

    final response = await http.Response.fromStream(await _http.send(request));
    Map<String, dynamic> parsed;
    try {
      parsed = response.body.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      parsed = {'error': response.body};
    }

    if (response.statusCode >= 200 && response.statusCode < 300) return parsed;
    if (response.statusCode == 401 && token != null) await storage.clear();
    throw ChallengesException(
      parsed['error'] as String? ?? response.reasonPhrase ?? 'request failed',
      response.statusCode,
      parsed,
    );
  }
}
