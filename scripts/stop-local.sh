#!/usr/bin/env bash
# Stop PilotDeck processes started by scripts/start-local.sh (or leftover dev servers).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib-local-runtime.sh"

PID_FILE="${RUNTIME_DIR}/pilotdeck.pid"
LOG_FILE="${RUNTIME_DIR}/logs/pilotdeck-dev.log"
PORTS=(3001 18789 5173)

kill_tree() {
  local pid="$1"
  local child
  # Kill children first (concurrently / vite / gateway / server).
  while read -r child; do
    [[ -n "$child" ]] || continue
    kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "$pid" 2>/dev/null || true
}

wait_gone() {
  local pid="$1"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.3
  done
  kill -9 "$pid" 2>/dev/null || true
}

echo "==> Stopping PilotDeck"

stopped_any=0

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "    pid file: ${pid}"
    kill_tree "$pid"
    wait_gone "$pid"
    stopped_any=1
  else
    echo "    pid file stale; removing"
  fi
  rm -f "$PID_FILE"
fi

# Also clear common leftover listeners from prior manual npm run dev.
for port in "${PORTS[@]}"; do
  # lsof may be missing on some systems; ignore failures.
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "    freeing port ${port}: ${pids}"
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    sleep 0.4
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
    stopped_any=1
  fi
done

# Catch orphaned launcher / gateway if ports already freed.
pkill -f "${PILOTDECK_ROOT}/scripts/dev-launcher.mjs" 2>/dev/null || true
pkill -f "${PILOTDECK_ROOT}/src/cli/pilotdeck.ts server" 2>/dev/null || true

if [[ "$stopped_any" -eq 0 ]]; then
  echo "    nothing was running"
else
  echo "    stopped"
fi

if [[ -f "$LOG_FILE" ]]; then
  echo "    last log: ${LOG_FILE}"
fi
