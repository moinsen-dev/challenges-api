@icon("res://addons/challenges_api/icon.svg")
class_name ChallengesAPI
extends Node

## Client for the Challenges API — leaderboards, qualifications, challenges,
## badges and geographic titles.
##
## Only the public key belongs in a game build. Anything carrying authority
## (creating disciplines, reporting duels, granting collectibles) is a server
## call and is deliberately absent here.
##
## [codeblock]
## var api := ChallengesAPI.new()
## api.base_url = "https://challenges-api.moinsen.dev"
## api.app_key = "chapi_pk_..."
## add_child(api)
##
## await api.sign_in()
## var result: Dictionary = await api.submit("score-attack", score)
## if result.ok and result.data.qualified_now:
##     show_toast("You are on the board!")
## [/codeblock]

## Emitted after every call, successful or not. Useful for a global spinner.
signal request_finished(path: String, ok: bool)
## Emitted when the player token stops being accepted. Call sign_in() again.
signal signed_out()

const _TOKEN_PATH := "user://challenges_token.txt"

@export var base_url: String = "https://challenges-api.moinsen.dev"
@export var app_key: String = ""
## Where the player token is kept between sessions. Empty disables persistence.
@export var token_path: String = _TOKEN_PATH

var _token: String = ""


func _ready() -> void:
	if app_key.begins_with("chapi_sk_"):
		push_error("ChallengesAPI: that is a secret key. Only a public key belongs in a game build.")
		app_key = ""
	_token = _load_token()


## The stored player token, or "" when signed out.
func token() -> String:
	return _token


## Adopt a token minted elsewhere — another device, another app.
func use_token(value: String) -> void:
	_token = value
	_save_token(value)


func sign_out() -> void:
	_token = ""
	if token_path != "":
		DirAccess.remove_absolute(token_path)


## Create an anonymous account, or keep the one already stored.
## [param handle] is optional; the server invents one when omitted.
func sign_in(handle: String = "", invite_code: String = "") -> Dictionary:
	if _token != "":
		var existing: Dictionary = await me()
		if existing.ok:
			return existing
		# A token the server no longer accepts is worse than none at all.
		sign_out()
	var body := {}
	if handle != "":
		body["handle"] = handle
	if invite_code != "":
		body["invite_code"] = invite_code
	var created: Dictionary = await _call("POST", "/v1/auth/anonymous", body)
	if created.ok:
		use_token(created.data.get("token", ""))
		return await me()
	return created


func me() -> Dictionary:
	return await _call("GET", "/v1/me")


func catalog() -> Dictionary:
	return await _call("GET", "/v1/catalog")


## The home district. Locked for the rest of the season once chosen.
func choose_region(region_id: String) -> Dictionary:
	return await _call("PATCH", "/v1/me/region", {"region_id": region_id})


## Submit one entry. [param meta] is free-form and capped at 4 KB — never put
## personal data in it.
func submit(discipline: String, value: float, meta: Dictionary = {}, idem_key: String = "") -> Dictionary:
	var body := {"discipline": discipline, "value": value}
	if not meta.is_empty():
		body["meta"] = meta
	if idem_key != "":
		body["idem_key"] = idem_key
	return await _call("POST", "/v1/entries", body)


## Own value, rank, streak and exam status for one discipline.
func status(discipline: String) -> Dictionary:
	return await _call("GET", "/v1/disciplines/%s/me" % discipline.uri_encode())


## [param region] empty means the global board. [param scope] may be "friends".
## [param cursor] comes from a previous answer and pages further down.
func leaderboard(discipline: String, region: String = "", limit: int = 25, scope: String = "", cursor: String = "") -> Dictionary:
	var query := "?limit=%d" % limit
	if region != "":
		query += "&region=" + region.uri_encode()
	if scope != "":
		query += "&scope=" + scope.uri_encode()
	if cursor != "":
		query += "&cursor=" + cursor.uri_encode()
	return await _call("GET", "/v1/leaderboards/%s%s" % [discipline.uri_encode(), query])


## The rows immediately around the player — what a game actually shows. Costs
## the same whether they are 4th or 40,000th.
func around(discipline: String, region: String = "", span: int = 2) -> Dictionary:
	var query := "?span=%d" % span
	if region != "":
		query += "&region=" + region.uri_encode()
	return await _call("GET", "/v1/leaderboards/%s/around%s" % [discipline.uri_encode(), query])


## The same seed for every player worldwide on a given day.
func daily(discipline: String) -> Dictionary:
	return await _call("GET", "/v1/daily/%s" % discipline.uri_encode())


func challenge(discipline: String, opponent_handle: String = "") -> Dictionary:
	var body := {"discipline": discipline}
	if opponent_handle != "":
		body["opponent_handle"] = opponent_handle
	return await _call("POST", "/v1/challenges", body)


func accept_challenge(challenge_id: String) -> Dictionary:
	return await _call("POST", "/v1/challenges/%s/accept" % challenge_id.uri_encode())


func challenges() -> Dictionary:
	return await _call("GET", "/v1/challenges")


func events(since: int = 0) -> Dictionary:
	return await _call("GET", "/v1/events?since=%d" % since)


## Tell the platform the player is around. Call every 30–60 seconds.
func presence(status: String = "online", detail: String = "") -> Dictionary:
	var body := {"status": status}
	if detail != "":
		body["detail"] = detail
	return await _call("POST", "/v1/me/presence", body)


## A count of everyone online, and names only for the player's own rivals.
func who_is_online() -> Dictionary:
	return await _call("GET", "/v1/presence")


## Enter matchmaking. Poll [method queue_state] until it stops saying "waiting".
func queue_join(discipline: String, party_id: String = "") -> Dictionary:
	var body := {"discipline": discipline}
	if party_id != "":
		body["party_id"] = party_id
	return await _call("POST", "/v1/queue", body)


## When matched, the answer carries `join_ticket` — hand it to the match
## server, which verifies it with the app's signing secret and never calls us.
func queue_state(ticket: String) -> Dictionary:
	return await _call("GET", "/v1/queue/%s" % ticket.uri_encode())


func queue_leave(ticket: String) -> Dictionary:
	return await _call("DELETE", "/v1/queue/%s" % ticket.uri_encode())


## The runs at the top of a board, with the trace each was made of — so a
## player can race the district champion while they sleep. Verified runs only.
func ghosts(discipline: String, region: String = "", limit: int = 5) -> Dictionary:
	var query := "?limit=%d" % limit
	if region != "":
		query += "&region=" + region.uri_encode()
	return await _call("GET", "/v1/ghosts/%s%s" % [discipline.uri_encode(), query])


## The whole bracket, drawable from this answer alone.
func tournament(slug: String) -> Dictionary:
	return await _call("GET", "/v1/tournaments/%s" % slug.uri_encode())


func tournament_join(slug: String) -> Dictionary:
	return await _call("POST", "/v1/tournaments/%s/join" % slug.uri_encode())


## Titles awarded so far. Each carries an id whose card.svg can be shown.
func titles(region: String = "") -> Dictionary:
	var query := "" if region == "" else "?region=" + region.uri_encode()
	return await _call("GET", "/v1/titles%s" % query)


## One-time code to carry this identity to another device or another app.
func link_code() -> Dictionary:
	return await _call("POST", "/v1/me/link-code")


func redeem_link_code(code: String) -> Dictionary:
	var claimed: Dictionary = await _call("POST", "/v1/auth/redeem", {"code": code})
	if claimed.ok:
		use_token(claimed.data.get("token", ""))
		return await me()
	return claimed


# ---------------------------------------------------------------- internals


func _call(method: String, path: String, body: Variant = null) -> Dictionary:
	if app_key == "":
		return _failure(0, "app_key is not set")

	var request := HTTPRequest.new()
	add_child(request)

	var headers := ["Content-Type: application/json", "X-App-Key: " + app_key]
	if _token != "":
		headers.append("Authorization: Bearer " + _token)

	var verb := HTTPClient.METHOD_GET
	match method:
		"POST":
			verb = HTTPClient.METHOD_POST
		"PATCH":
			verb = HTTPClient.METHOD_PATCH
		"DELETE":
			verb = HTTPClient.METHOD_DELETE

	var payload := "" if body == null else JSON.stringify(body)
	var started := request.request(base_url + path, headers, verb, payload)
	if started != OK:
		request.queue_free()
		return _failure(0, "request could not be started")

	var response: Array = await request.request_completed
	request.queue_free()

	var status: int = response[1]
	var text := (response[3] as PackedByteArray).get_string_from_utf8()
	var parsed: Variant = JSON.parse_string(text)
	var data: Dictionary = parsed if parsed is Dictionary else {}

	var ok := status >= 200 and status < 300
	if not ok and status == 401 and _token != "":
		# The account is gone or the token was revoked. Do not loop on it.
		sign_out()
		signed_out.emit()

	request_finished.emit(path, ok)
	if ok:
		return {"ok": true, "status": status, "data": data, "error": ""}
	return _failure(status, str(data.get("error", "request failed")), data)


func _failure(status: int, message: String, data: Dictionary = {}) -> Dictionary:
	return {"ok": false, "status": status, "data": data, "error": message}


func _load_token() -> String:
	if token_path == "" or not FileAccess.file_exists(token_path):
		return ""
	var file := FileAccess.open(token_path, FileAccess.READ)
	return "" if file == null else file.get_as_text().strip_edges()


func _save_token(value: String) -> void:
	if token_path == "":
		return
	var file := FileAccess.open(token_path, FileAccess.WRITE)
	if file != null:
		file.store_string(value)
