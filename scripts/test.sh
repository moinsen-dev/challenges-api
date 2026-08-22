#!/usr/bin/env bash
# Full proof from a cold start: fresh database, real worker, real checks.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8799}"

# A fresh clone has no .dev.vars, and without ADMIN_KEY the worker correctly
# refuses every operator call — which used to surface as fifteen confusing
# smoke-test failures instead of one missing file.
[ -f .dev.vars ] || cp .dev.vars.example .dev.vars

pkill -f "wrangler dev --port $PORT" 2>/dev/null || true
rm -rf .wrangler/state/v3/d1
npx wrangler d1 migrations apply challenges --local > /dev/null

LOG="${TMPDIR:-/tmp}/challenges-dev-$PORT.log"
npx wrangler dev --port "$PORT" > "$LOG" 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT

# Wait for the worker, and say so plainly if it never arrives. Falling through
# silently means every check afterwards fails against whatever else happens to
# hold the port, which reads like a broken test suite rather than a busy port.
READY=""
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/v1/status" > /dev/null; then READY=1; break; fi
  kill -0 $DEV_PID 2>/dev/null || break
  sleep 1
done

if [ -z "$READY" ]; then
  echo "The dev server never answered on port $PORT. Its output:"
  echo
  tail -20 "$LOG"
  echo
  echo "If the port is taken, run with another one:  PORT=8822 npm test"
  exit 1
fi

echo "── Unit and integration tests inside the Workers runtime (with coverage)"
npx vitest run --coverage

echo
echo "── Live smoke test over HTTP against the running worker"
BASE="http://127.0.0.1:$PORT" node scripts/smoke.mjs

echo
echo "── Replay verification with the real verifier process"
BASE="http://127.0.0.1:$PORT" bash scripts/verify-test.sh

echo
echo "── Client SDKs against the running worker"
BASE="http://127.0.0.1:$PORT" bash scripts/sdk-test.sh
