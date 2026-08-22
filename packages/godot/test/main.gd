extends Node

## Headless end-to-end test for the Godot client.
##   godot --headless --path packages/godot -- --base=http://127.0.0.1:8799 --key=chapi_pk_...

var failures := 0
var api: ChallengesAPI


func _ready() -> void:
	var base := _argument("base", "http://127.0.0.1:8799")
	var key := _argument("key", "")
	if key == "":
		printerr("pass --key=chapi_pk_...")
		get_tree().quit(2)
		return

	# A fresh identity per run, so the test is repeatable.
	DirAccess.remove_absolute("user://challenges_token.txt")

	api = ChallengesAPI.new()
	api.base_url = base
	api.app_key = key
	add_child(api)

	await _run(_argument("discipline", "score-attack"))

	print("")
	if failures == 0:
		print("GODOT CLIENT PASSED")
	else:
		printerr("%d CHECK(S) FAILED" % failures)
	get_tree().quit(0 if failures == 0 else 1)


func _run(discipline: String) -> void:
	var handle := "godot-%d" % (Time.get_unix_time_from_system() * 1000)

	var me: Dictionary = await api.sign_in(handle)
	_check(me.ok, "signs in anonymously", me)
	_check(api.token() != "", "keeps a token")
	_check(me.data.get("player", {}).get("handle", "") == handle, "uses the handle we asked for", me)

	var catalog: Dictionary = await api.catalog()
	_check(catalog.ok and catalog.data.get("regions", []).size() > 5, "reads the catalog", catalog)

	var region: Dictionary = await api.choose_region("hh-altona")
	_check(region.ok, "chooses a home district", region)

	var weak: Dictionary = await api.submit(discipline, 40.0)
	_check(weak.ok and weak.data.get("qualified") == false, "an entry below the bar is unqualified", weak)

	var passed: Dictionary = await api.submit(discipline, 5000.0, {"device": "godot-headless"})
	_check(passed.ok and passed.data.get("qualified_now") == true, "passes the exam", passed)

	var status: Dictionary = await api.status(discipline)
	_check(status.ok and status.data.get("value") == 5000, "reads its own standing", status)

	var board: Dictionary = await api.leaderboard(discipline, "hh-altona", 10)
	var entries: Array = board.data.get("entries", [])
	_check(board.ok and entries.size() >= 1, "reads a regional leaderboard", board)

	var seed_a: Dictionary = await api.daily(discipline)
	var seed_b: Dictionary = await api.daily(discipline)
	_check(seed_a.ok and seed_a.data.get("seed") == seed_b.data.get("seed"), "daily seed is stable", seed_a)

	var idem := "godot-%s" % handle
	var first: Dictionary = await api.submit(discipline, 111.0, {}, idem)
	var again: Dictionary = await api.submit(discipline, 111.0, {}, idem)
	_check(again.data.get("duplicate") == true, "idempotency key is honoured", again)
	_check(first.data.get("entry_id") == again.data.get("entry_id"), "same entry comes back")

	var unknown: Dictionary = await api.submit("does-not-exist-here", 1.0)
	_check(not unknown.ok and unknown.status == 404, "an unknown discipline fails cleanly", unknown)
	_check(unknown.error == "unknown discipline", "and carries the server's own words", unknown)

	var code: Dictionary = await api.link_code()
	_check(code.ok and code.data.get("code", "").length() == 6, "mints a link code", code)

	# A token the server does not know must not leave the client looping.
	api.use_token("0".repeat(64))
	var refused: Dictionary = await api.me()
	_check(not refused.ok and refused.status == 401, "a dead token is refused", refused)
	_check(api.token() == "", "and is forgotten")


func _check(condition: bool, label: String, detail: Variant = null) -> void:
	if condition:
		print("  ok   %s" % label)
	else:
		failures += 1
		printerr(" FAIL  %s%s" % [label, "" if detail == null else " — " + JSON.stringify(detail)])


func _argument(name: String, fallback: String) -> String:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--%s=" % name):
			return argument.substr(name.length() + 3)
	return fallback
