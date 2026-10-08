#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/offline-runtime.sh"

prepare_environment

if pid_is_running "$OFFLINE_STATE_DIR/gateway.pid" || pid_is_running "$OFFLINE_STATE_DIR/ui.pid"; then
  echo "PilotDeck is already running. Use scripts/status-offline.sh." >&2
  exit 1
fi

if [[ "${OFFLINE_SKIP_PYTHON_PREPARE:-0}" != "1" ]]; then
  bash "$SCRIPT_DIR/prepare-offline-runtime.sh"
fi

if [[ "${SKIP_LLM_CHECK:-0}" != "1" ]]; then
  "$RUNTIME_NODE_DIR/bin/node" "$PILOTDECK_ROOT/scripts/check-llm-config.mjs" \
    --pilot-home "$PILOT_HOME"
fi

bash "$SCRIPT_DIR/check-offline.sh"

rm -f "$OFFLINE_STATE_DIR/gateway.pid" "$OFFLINE_STATE_DIR/ui.pid"
gateway_log="$OFFLINE_LOG_DIR/pilotdeck-gateway.log"
ui_log="$OFFLINE_LOG_DIR/pilotdeck-ui.log"

(
  cd "$PILOTDECK_ROOT"
  exec "$RUNTIME_NODE_DIR/bin/node" \
    --import "$PILOTDECK_ROOT/scripts/register-deploy-env.mjs" \
    "$PILOTDECK_ROOT/dist/src/cli/pilotdeck.js" server
) >"$gateway_log" 2>&1 &
gateway_pid=$!
echo "$gateway_pid" >"$OFFLINE_STATE_DIR/gateway.pid"

for _ in {1..30}; do
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    echo "gateway exited during startup; see $gateway_log" >&2
    exit 1
  fi
  if (exec 3<>"/dev/tcp/127.0.0.1/${PILOTDECK_GATEWAY_PORT}") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    break
  fi
  sleep 1
done

(
  cd "$PILOTDECK_ROOT"
  exec "$RUNTIME_NODE_DIR/bin/node" \
    --import "$PILOTDECK_ROOT/node_modules/tsx/dist/loader.mjs" \
    "$PILOTDECK_ROOT/ui/server/index.js"
) >"$ui_log" 2>&1 &
ui_pid=$!
echo "$ui_pid" >"$OFFLINE_STATE_DIR/ui.pid"

ui_ready=0
for _ in {1..30}; do
  if ! kill -0 "$ui_pid" 2>/dev/null; then
    echo "UI server exited during startup; see $ui_log" >&2
    bash "$SCRIPT_DIR/stop-offline.sh" || true
    exit 1
  fi
  if (exec 4<>"/dev/tcp/127.0.0.1/${SERVER_PORT}") 2>/dev/null; then
    exec 4>&- 2>/dev/null || true
    ui_ready=1
    break
  fi
  sleep 1
done

if (( ui_ready == 0 )); then
  echo "UI server did not become ready on port ${SERVER_PORT}; see $ui_log" >&2
  bash "$SCRIPT_DIR/stop-offline.sh" || true
  exit 1
fi

echo "PilotDeck offline services started"
echo "  UI:      http://127.0.0.1:${SERVER_PORT}"
echo "  gateway: ws://127.0.0.1:${PILOTDECK_GATEWAY_PORT}/ws"
echo "  home:    $PILOT_HOME"
echo "  logs:    $OFFLINE_LOG_DIR"
