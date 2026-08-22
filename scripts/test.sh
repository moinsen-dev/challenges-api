#!/usr/bin/env bash
# Full proof from a cold start: fresh database, real worker, real checks.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8799}"

pkill -f "wrangler dev --port $PORT" 2>/dev/null || true
rm -rf .wrangler/state/v3/d1
npx wrangler d1 migrations apply challenges --local > /dev/null

npx wrangler dev --port "$PORT" > /tmp/challenges-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/v1/status" > /dev/null && break
  sleep 1
done

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
