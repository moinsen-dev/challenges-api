#!/usr/bin/env bash
# Exercises the Godot and Dart clients against a RUNNING instance.
#
# The JavaScript client is covered inside `npm run test:unit`, because it can
# run in the same Workers runtime. These two need real processes, so they get
# their own script — and they are skipped, loudly, when the toolchain is absent.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE:-http://127.0.0.1:8799}"
ADMIN="${ADMIN_KEY:-dev-admin-key}"
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"

echo "── Provisioning a throwaway app on $BASE"
APP=$(curl -sf -X POST "$BASE/v1/admin/apps" \
  -H "X-Admin-Key: $ADMIN" -H 'Content-Type: application/json' \
  -d "{\"slug\":\"sdk-$(date +%s)\",\"name\":\"SDK test\"}")
PK=$(printf '%s' "$APP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["public_key"])')
SK=$(printf '%s' "$APP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["secret_key"])')

curl -sf -X POST "$BASE/v1/disciplines" \
  -H "X-App-Key: $SK" -H 'Content-Type: application/json' \
  -d '{"slug":"score-attack","name":"Score Attack","trust_tier":1,"qualifying_score":100,"max_title_level":2}' \
  > /dev/null
curl -sf -X POST "$BASE/v1/disciplines" \
  -H "X-App-Key: $SK" -H 'Content-Type: application/json' \
  -d '{"slug":"duel","name":"Duel","trust_tier":2,"head_to_head":true,"max_title_level":2}' \
  > /dev/null

if [ -x "$GODOT" ]; then
  echo
  echo "── Godot client (headless)"
  "$GODOT" --headless --path packages/godot --import > /dev/null 2>&1 || true
  "$GODOT" --headless --path packages/godot -- --base="$BASE" --key="$PK" 2>&1 | grep -vE '^Godot Engine|^$'
else
  echo "── Godot client SKIPPED (no engine at $GODOT)"
fi

if command -v dart > /dev/null; then
  echo
  echo "── Dart client"
  (cd packages/dart && dart pub get > /dev/null && BASE="$BASE" APP_KEY="$PK" dart test)
else
  echo "── Dart client SKIPPED (no dart on PATH)"
fi
