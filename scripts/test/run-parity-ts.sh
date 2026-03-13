#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentmonitor-parity-ts.XXXXXX")"
SERVER_LOG="$TMP_DIR/server.log"
SERVER_PID=""

cleanup() {
  local exit_code=$?
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

PORT="$(
  node -e "const net = require('node:net'); const server = net.createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });"
)"

mkdir -p "$TMP_DIR/home"

cd "$ROOT_DIR"

env \
  HOME="$TMP_DIR/home" \
  CODEX_HOME="$TMP_DIR/home/.codex" \
  AGENTMONITOR_HOST="127.0.0.1" \
  AGENTMONITOR_PORT="$PORT" \
  AGENTMONITOR_DB_PATH="$TMP_DIR/agentmonitor.db" \
  AGENTMONITOR_AUTO_IMPORT_MINUTES="0" \
  node --import tsx src/server.ts >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; then
    AGENTMONITOR_BASE_URL="http://127.0.0.1:$PORT" \
      node --import tsx --test tests/parity/**/*.test.ts
    exit 0
  fi
  sleep 1
done

echo "Parity TypeScript server failed to start" >&2
cat "$SERVER_LOG" >&2
exit 1
