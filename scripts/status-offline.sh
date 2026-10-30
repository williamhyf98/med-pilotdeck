#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/offline-runtime.sh"

prepare_environment

status_one() {
  local name="$1"
  local pid_file="$2"
  if pid_is_running "$pid_file"; then
    echo "$name: running (pid $(cat "$pid_file"))"
  else
    echo "$name: stopped"
  fi
}

status_one gateway "$OFFLINE_STATE_DIR/gateway.pid"
status_one ui "$OFFLINE_STATE_DIR/ui.pid"
echo "home: $PILOT_HOME"
echo "logs: $OFFLINE_LOG_DIR"
