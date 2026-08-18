#!/usr/bin/env bash
# Start PilotDeck in the background (dev mode).
# Prefers project-local .runtime Node if present; otherwise Node 22 from PATH / Homebrew.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib-local-runtime.sh"

PID_FILE="${RUNTIME_DIR}/pilotdeck.pid"
LOG_FILE="${RUNTIME_DIR}/logs/pilotdeck-dev.log"
DEFAULT_PORTS=(3001 18789 5173)

ensure_node22() {
  local ver major
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node not found in PATH" >&2
    return 1
  fi
  ver="$(node -v 2>/dev/null || true)"
  major="$(echo "$ver" | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$major" != "22" ]]; then
    # Try Homebrew node@22 without changing the user's global brew links permanently.
    if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
      export PATH="/opt/homebrew/opt/node@22/bin:${PATH}"
      ver="$(node -v 2>/dev/null || true)"
      major="$(echo "$ver" | sed -E 's/^v([0-9]+).*/\1/')"
    elif [[ -x /usr/local/opt/node@22/bin/node ]]; then
      export PATH="/usr/local/opt/node@22/bin:${PATH}"
      ver="$(node -v 2>/dev/null || true)"
      major="$(echo "$ver" | sed -E 's/^v([0-9]+).*/\1/')"
    fi
  fi
  if [[ "$major" != "22" ]]; then
    echo "error: PilotDeck needs Node.js 22 (got ${ver:-unknown})." >&2
    echo "  brew install node@22" >&2
    echo "  # or: ${PILOTDECK_ROOT}/scripts/bootstrap-runtime.sh" >&2
    return 1
  fi
}

already_running() {
  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "PilotDeck already running (pid ${old_pid})." >&2
      echo "  stop:  ${SCRIPT_DIR}/stop-local.sh" >&2
      echo "  log:   ${LOG_FILE}" >&2
      return 0
    fi
    rm -f "$PID_FILE"
  fi
  return 1
}

apply_local_runtime_env

# If project-local Node is missing, keep system/Homebrew Node 22 on PATH.
if [[ ! -x "$(runtime_node)" ]]; then
  # Remove empty .runtime/node/bin prefix noise by re-exporting without missing bin.
  cleaned_path="$(strip_forbidden_from_path "${PATH:-}")"
  export PATH="${cleaned_path}"
fi

ensure_node22
assert_no_share

# Medical MCP (G9-V-Med) can take >60s for a full trauma stage plan.
export PILOTDECK_MCP_TOOL_TIMEOUT_MS="${PILOTDECK_MCP_TOOL_TIMEOUT_MS:-300000}"

if already_running; then
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"
cd "$PILOTDECK_ROOT"

echo "==> Starting PilotDeck (dev)"
echo "    root:  ${PILOTDECK_ROOT}"
echo "    home:  ${PILOT_HOME}"
echo "    node:  $(command -v node) ($(node -v))"
echo "    log:   ${LOG_FILE}"
echo "    ports: server=${SERVER_PORT:-3001} gateway=${PILOTDECK_GATEWAY_PORT:-18789} vite=${VITE_PORT:-5173}"
echo "    mcp timeout: ${PILOTDECK_MCP_TOOL_TIMEOUT_MS}ms"

# Foreground mode when user passes --fg
if [[ "${1:-}" == "--fg" ]]; then
  shift || true
  if [[ "$#" -eq 0 ]]; then
    exec npm run dev
  fi
  exec "$@"
fi

nohup npm run dev >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

sleep 1
if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "error: process exited immediately; see log:" >&2
  echo "  tail -n 80 ${LOG_FILE}" >&2
  rm -f "$PID_FILE"
  exit 1
fi

echo "    pid:   $(cat "$PID_FILE")"
echo "    UI:    http://localhost:${VITE_PORT:-5173}"
echo "    API:   http://localhost:${SERVER_PORT:-3001}"
echo "    stop:  ${SCRIPT_DIR}/stop-local.sh"
echo "    logs:  tail -f ${LOG_FILE}"
