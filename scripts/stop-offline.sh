#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/offline-runtime.sh"

prepare_environment

stop_one() {
  local name="$1"
  local pid_file="$2"
  [[ -s "$pid_file" ]] || return 0
  local pid
  pid="$(cat "$pid_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "forcing $name (pid $pid)"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_file"
}

stop_one "UI" "$OFFLINE_STATE_DIR/ui.pid"
stop_one "gateway" "$OFFLINE_STATE_DIR/gateway.pid"
echo "PilotDeck offline services stopped"
