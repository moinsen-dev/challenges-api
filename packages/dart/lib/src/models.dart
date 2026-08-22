/// Everything the client throws. The API's plain-words message is [message].
class ChallengesException implements Exception {
  ChallengesException(this.message, this.statusCode, this.body);

  final String message;
  final int statusCode;
  final Map<String, dynamic> body;

  /// True when the player must sign in again — the token is gone or invalid.
  bool get needsSignIn => statusCode == 401;

  @override
  String toString() => 'ChallengesException($statusCode): $message';
}

/// Where the player token is kept between launches.
abstract class TokenStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> clear();
}

/// Keeps the token for this process only. Replace it with one backed by
/// shared_preferences or the keychain in a real app.
class MemoryTokenStore implements TokenStore {
  String? _token;

  @override
  Future<String?> read() async => _token;

  @override
  Future<void> write(String token) async => _token = token;

  @override
  Future<void> clear() async => _token = null;
}

class Rank {
  const Rank({required this.rank, required this.of, required this.value});

  final int rank;
  final int of;
  final num value;

  static Rank? fromJson(Map<String, dynamic>? json) => json == null
      ? null
      : Rank(rank: json['rank'] as int, of: json['of'] as int, value: json['value'] as num);
}

class EntryResult {
  EntryResult(this._json);

  final Map<String, dynamic> _json;

  String get entryId => _json['entry_id'] as String;
  String get status => _json['status'] as String? ?? 'counted';
  num get value => _json['value'] as num? ?? 0;
  num get aggregate => _json['aggregate'] as num? ?? 0;
  String get aggregation => _json['aggregation'] as String? ?? 'best';
  bool get qualified => _json['qualified'] as bool? ?? false;
  bool get qualifiedNow => _json['qualified_now'] as bool? ?? false;
  bool get duplicate => _json['duplicate'] as bool? ?? false;

  /// Null until the player has passed the exam.
  Rank? get regionRank =>
      Rank.fromJson((_json['rank'] as Map<String, dynamic>?)?['region'] as Map<String, dynamic>?);
  Rank? get globalRank =>
      Rank.fromJson((_json['rank'] as Map<String, dynamic>?)?['global'] as Map<String, dynamic>?);

  /// Live daily streak, for streak disciplines.
  int? get streakDays => _json['streak_days'] as int?;

  List<String> get settledChallenges =>
      (_json['settled_challenges'] as List? ?? []).cast<String>();

  List<String> get badgesEarned => (_json['badges_earned'] as List? ?? [])
      .map((badge) => (badge as Map<String, dynamic>)['id'] as String)
      .toList();

  Map<String, dynamic> toJson() => _json;
}

class Standing {
  const Standing({required this.rank, required this.handle, required this.value});

  final int rank;
  final String handle;
  final num value;

  static Standing fromJson(Map<String, dynamic> json) => Standing(
        rank: json['rank'] as int,
        handle: json['handle'] as String,
        value: json['value'] as num,
      );
}

class Leaderboard {
  Leaderboard(this._json);

  final Map<String, dynamic> _json;

  String get discipline => _json['discipline'] as String;
  String get region => _json['region'] as String;
  int get contenders => _json['contenders'] as int? ?? 0;
  int get trustTier => _json['trust_tier'] as int? ?? 0;

  /// Honest: false means this region cannot crown anybody yet.
  bool get titleEligible => _json['title_eligible'] as bool? ?? false;

  /// Pass back as `cursor` for the next page. Null means this was the last.
  String? get cursor => _json['cursor'] as String?;

  List<Standing> get entries =>
      (_json['entries'] as List? ?? []).map((e) => Standing.fromJson(e as Map<String, dynamic>)).toList();
}

class DisciplineStatus {
  DisciplineStatus(this._json);

  final Map<String, dynamic> _json;

  num? get value => _json['value'] as num?;
  bool get qualified => _json['qualified'] as bool? ?? false;
  num? get qualifyingScore => _json['qualifying_score'] as num?;
  int get streakDays => _json['streak_days'] as int? ?? 0;
  Rank? get regionRank =>
      Rank.fromJson((_json['rank'] as Map<String, dynamic>?)?['region'] as Map<String, dynamic>?);
}

class Profile {
  Profile(this._json);

  final Map<String, dynamic> _json;

  Map<String, dynamic> get player => _json['player'] as Map<String, dynamic>;
  String get id => player['id'] as String;
  String get handle => player['handle'] as String;
  String? get displayName => player['display_name'] as String?;
  String? get regionId => (_json['region'] as Map<String, dynamic>?)?['id'] as String?;
  List<Map<String, dynamic>> get titles =>
      (_json['titles'] as List? ?? []).cast<Map<String, dynamic>>();
  List<Map<String, dynamic>> get badges =>
      (_json['badges'] as List? ?? []).cast<Map<String, dynamic>>();
}
