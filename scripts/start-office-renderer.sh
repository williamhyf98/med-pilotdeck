#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib-local-runtime.sh"

apply_local_runtime_env
PID_FILE="${RUNTIME_DIR}/office-renderer.pid"
LOG_FILE="${RUNTIME_DIR}/logs/office-renderer.log"
PORT="${PILOTDECK_OFFICE_RENDERER_PORT:-19400}"

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "Office Renderer already running (pid ${old_pid})."
    exit 0
  fi
  rm -f "$PID_FILE"
fi

mkdir -p "$(dirname "$LOG_FILE")"
cd "$PILOTDECK_ROOT"
echo "==> Starting Office Renderer"
echo "    root: ${PILOTDECK_ROOT}"
echo "    node: $(runtime_node)"
echo "    bind: ${PILOTDECK_OFFICE_RENDERER_HOST:-0.0.0.0}:${PORT}"
echo "    log:  ${LOG_FILE}"

nohup "$(runtime_node)" office-renderer/server.mjs >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
sleep 1
if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "error: Office Renderer exited immediately; see ${LOG_FILE}" >&2
  rm -f "$PID_FILE"
  exit 1
fi
echo "    pid:  $(cat "$PID_FILE")"
