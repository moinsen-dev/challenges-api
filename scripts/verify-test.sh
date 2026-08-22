#!/usr/bin/env bash
# The verification pipeline end to end, with the real verifier process.
#
# The API side is covered by the unit tests; what cannot be tested there is the
# part that matters most — actually re-simulating WebAssembly, which the
# Workers runtime refuses to do. So this drives a running instance with the
# verifier that would run in production.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE:-http://127.0.0.1:8799}"
ADMIN="${ADMIN_KEY:-dev-admin-key}"
STAMP=$(date +%s)
fails=0

check() {
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo " FAIL  $1 — expected $3, got $2"
    fails=$((fails + 1))
  fi
}

jsonq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

echo
echo "── Replay verification against $BASE"

APP=$(curl -sf -X POST "$BASE/v1/admin/apps" -H "X-Admin-Key: $ADMIN" \
  -H 'Content-Type: application/json' -d "{\"slug\":\"verify-$STAMP\",\"name\":\"Verify\"}")
PK=$(printf '%s' "$APP" | jsonq 'd["public_key"]')
SK=$(printf '%s' "$APP" | jsonq 'd["secret_key"]')

# The module and the honest score come from the same fixture the unit tests use.
node -e "
const { scorer } = await import('./tests/fixtures/wasm.ts')
process.stdout.write(Buffer.from(scorer, 'base64'))
" > /tmp/scorer.wasm
check "module compiled" "$([ -s /tmp/scorer.wasm ] && echo yes)" "yes"

MOD=$(curl -sf -X POST "$BASE/v1/verifier/modules?name=core" \
  -H "X-App-Key: $SK" -H 'Content-Type: application/wasm' \
  --data-binary @/tmp/scorer.wasm)
check "module uploaded" "$(printf '%s' "$MOD" | jsonq '"yes" if d["exports"].count("verify") else "no"')" "yes"

curl -sf -X POST "$BASE/v1/disciplines" -H "X-App-Key: $SK" -H 'Content-Type: application/json' \
  -d '{"slug":"proved","name":"Proved","trust_tier":1,"max_title_level":2,"title_min_players":1}' > /dev/null
curl -sf -X POST "$BASE/v1/disciplines/proved/verifier" -H "X-App-Key: $SK" \
  -H 'Content-Type: application/json' -d '{"module":"core","export":"verify","timeout_ms":1500}' > /dev/null

TOKEN=$(curl -sf -X POST "$BASE/v1/auth/anonymous" -H "X-App-Key: $PK" \
  -H 'Content-Type: application/json' -d '{}' | jsonq 'd["token"]')

# The trace, and the score the module must produce from it.
TRACE_B64=$(python3 -c "import base64;print(base64.b64encode(bytes([3,1,4,1,5,9,2,6,5,3,5])).decode())")
HONEST=$(python3 -c "
s=0
for b in [3,1,4,1,5,9,2,6,5,3,5]: s=(s*31+b)%(2**64)
print(s)")

submit() {
  curl -sf -X POST "$BASE/v1/entries" -H "X-App-Key: $PK" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "{\"discipline\":\"proved\",\"value\":$1,\"trace\":\"$TRACE_B64\"}"
}

echo
echo "── An honest run"
HELD=$(submit "$HONEST")
check "held for verification" "$(printf '%s' "$HELD" | jsonq 'd["verification"]')" "pending"
check "not on the board yet" \
  "$(curl -sf "$BASE/v1/leaderboards/proved" -H "X-App-Key: $PK" | jsonq 'd["contenders"]')" "0"

BASE="$BASE" ADMIN_KEY="$ADMIN" node packages/verifier/src/index.mjs --once --worker=ci
ENTRY=$(printf '%s' "$HELD" | jsonq 'd["entry_id"]')
check "counted after re-simulation" \
  "$(curl -sf "$BASE/v1/leaderboards/proved" -H "X-App-Key: $PK" | jsonq 'd["contenders"]')" "1"

echo
echo "── A claimed score the trace does not produce"
TOKEN=$(curl -sf -X POST "$BASE/v1/auth/anonymous" -H "X-App-Key: $PK" \
  -H 'Content-Type: application/json' -d '{}' | jsonq 'd["token"]')
CHEAT=$(submit 999999999)
BASE="$BASE" ADMIN_KEY="$ADMIN" node packages/verifier/src/index.mjs --once --worker=ci
check "cheat stays off the board" \
  "$(curl -sf "$BASE/v1/leaderboards/proved" -H "X-App-Key: $PK" | jsonq 'd["contenders"]')" "1"

JOBS=$(curl -sf -X GET "$BASE/v1/verifier/jobs" -H "X-Admin-Key: $ADMIN")
check "verdict recorded as failed" \
  "$(printf '%s' "$JOBS" | jsonq '[j["verdict"] for j in d["jobs"]].count("failed")')" "1"
check "verdict recorded as verified" \
  "$(printf '%s' "$JOBS" | jsonq '[j["verdict"] for j in d["jobs"]].count("verified")')" "1"

echo
echo "── A module that never stops"
node -e "
const { endless } = await import('./tests/fixtures/wasm.ts')
process.stdout.write(Buffer.from(endless, 'base64'))
" > /tmp/endless.wasm
curl -sf -X POST "$BASE/v1/verifier/modules?name=endless" -H "X-App-Key: $SK" \
  -H 'Content-Type: application/wasm' --data-binary @/tmp/endless.wasm > /dev/null
curl -sf -X POST "$BASE/v1/disciplines" -H "X-App-Key: $SK" -H 'Content-Type: application/json' \
  -d '{"slug":"hangs","name":"Hangs","trust_tier":1}' > /dev/null
curl -sf -X POST "$BASE/v1/disciplines/hangs/verifier" -H "X-App-Key: $SK" \
  -H 'Content-Type: application/json' -d '{"module":"endless","export":"verify","timeout_ms":600}' > /dev/null

TOKEN=$(curl -sf -X POST "$BASE/v1/auth/anonymous" -H "X-App-Key: $PK" \
  -H 'Content-Type: application/json' -d '{}' | jsonq 'd["token"]')
curl -sf -X POST "$BASE/v1/entries" -H "X-App-Key: $PK" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"discipline\":\"hangs\",\"value\":1,\"trace\":\"$TRACE_B64\"}" > /dev/null

STARTED=$(date +%s)
BASE="$BASE" ADMIN_KEY="$ADMIN" node packages/verifier/src/index.mjs --once --worker=ci
ELAPSED=$(( $(date +%s) - STARTED ))
check "stopped by the timeout" "$([ "$ELAPSED" -lt 20 ] && echo yes)" "yes"
check "endless run counts for nobody" \
  "$(curl -sf "$BASE/v1/leaderboards/hangs" -H "X-App-Key: $PK" | jsonq 'd["contenders"]')" "0"

USAGE=$(curl -sf "$BASE/v1/verifier/usage" -H "X-App-Key: $SK")
check "cpu time metered" "$(printf '%s' "$USAGE" | jsonq '"yes" if d["usage"] and d["usage"][0]["count"] >= 3 else "no"')" "yes"

echo
if [ "$fails" -eq 0 ]; then
  echo "VERIFICATION PIPELINE PASSED"
else
  echo "$fails CHECK(S) FAILED"
  exit 1
fi
