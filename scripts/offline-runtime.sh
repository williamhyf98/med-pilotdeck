#!/usr/bin/env bash
# Shared runtime helpers for the relocatable Linux ARM64 offline package.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PILOTDECK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$PILOTDECK_ROOT/.runtime"
RUNTIME_NODE_DIR="$RUNTIME_DIR/node"
RUNTIME_PYTHON_DIR="$RUNTIME_DIR/python"
RUNTIME_CACHE_DIR="$RUNTIME_DIR/cache"
OFFLINE_DIR="$PILOTDECK_ROOT/offline"
PYTHON_WHEELS_DIR="$OFFLINE_DIR/python-wheels"
PILOT_HOME="${PILOT_HOME:-$PILOTDECK_ROOT/.pilotdeck-home}"
DEPLOY_ENV_FILE="${PILOTDECK_DEPLOY_ENV:-$PILOTDECK_ROOT/config/deploy.env}"
OFFLINE_STATE_DIR="$RUNTIME_DIR/offline"
OFFLINE_LOG_DIR="$RUNTIME_DIR/logs"

export PILOTDECK_ROOT RUNTIME_DIR RUNTIME_NODE_DIR RUNTIME_PYTHON_DIR
export RUNTIME_CACHE_DIR OFFLINE_DIR PYTHON_WHEELS_DIR PILOT_HOME
export DEPLOY_ENV_FILE OFFLINE_STATE_DIR OFFLINE_LOG_DIR

load_deploy_env() {
  [[ -f "$DEPLOY_ENV_FILE" ]] || return 0

  local raw body key value
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%$'\r'}"
    [[ -z "$raw" || "$raw" =~ ^[[:space:]]*# ]] && continue
    body="${raw#"${raw%%[![:space:]]*}"}"
    [[ "$body" == export\ * ]] && body="${body#export }"
    [[ "$body" == *=* ]] || continue
    key="${body%%=*}"
    value="${body#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#"${key%%[![:space:]]*}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value#\"}"
      value="${value%\"}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value#\'}"
      value="${value%\'}"
    fi
    if [[ -z "${!key+x}" || -z "${!key}" ]]; then
      export "$key=$value"
    fi
  done < "$DEPLOY_ENV_FILE"
}

runtime_node() {
  if [[ -x "$RUNTIME_NODE_DIR/bin/node" ]]; then
    printf '%s\n' "$RUNTIME_NODE_DIR/bin/node"
  else
    command -v node
  fi
}

runtime_python() {
  if [[ -x "$RUNTIME_PYTHON_DIR/bin/python3" ]]; then
    printf '%s\n' "$RUNTIME_PYTHON_DIR/bin/python3"
  elif [[ -x "$RUNTIME_PYTHON_DIR/bin/python" ]]; then
    printf '%s\n' "$RUNTIME_PYTHON_DIR/bin/python"
  else
    command -v python3 || command -v python
  fi
}

prepare_environment() {
  load_deploy_env
  export PILOT_HOME="${PILOT_HOME:-$PILOTDECK_ROOT/.pilotdeck-home}"
  export PILOTDECK_CONFIG_DIR="${PILOTDECK_CONFIG_DIR:-$PILOT_HOME}"
  export PILOTDECK_CONFIG_PATH="${PILOTDECK_CONFIG_PATH:-$PILOT_HOME/pilotdeck.yaml}"
  export PILOTDECK_TMPDIR="${PILOTDECK_TMPDIR:-$RUNTIME_CACHE_DIR/tmp}"
  export TMPDIR="${TMPDIR:-$PILOTDECK_TMPDIR}"
  export TMP="${TMP:-$TMPDIR}"
  export TEMP="${TEMP:-$TMPDIR}"
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$RUNTIME_CACHE_DIR/xdg}"
  export npm_config_cache="${npm_config_cache:-$RUNTIME_CACHE_DIR/npm}"
  export PIP_CACHE_DIR="${PIP_CACHE_DIR:-$RUNTIME_CACHE_DIR/pip}"
  export PIP_DISABLE_PIP_VERSION_CHECK=1
  export PIP_NO_INDEX=1
  export PIP_FIND_LINKS="${PIP_FIND_LINKS:-$PYTHON_WHEELS_DIR}"
  export PATH="$RUNTIME_NODE_DIR/bin:$RUNTIME_PYTHON_DIR/bin:$PATH"
  export PILOTDECK_SKIP_BROWSER_OPEN=1
  export PILOTDECK_GATEWAY_PORT="${PILOTDECK_GATEWAY_PORT:-18789}"
  export SERVER_PORT="${SERVER_PORT:-3010}"
  export PILOTDECK_GATEWAY_URL="${PILOTDECK_GATEWAY_URL:-ws://127.0.0.1:${PILOTDECK_GATEWAY_PORT}/ws}"

  mkdir -p \
    "$RUNTIME_CACHE_DIR/tmp" "$RUNTIME_CACHE_DIR/xdg" "$RUNTIME_CACHE_DIR/npm" \
    "$RUNTIME_CACHE_DIR/pip" "$OFFLINE_STATE_DIR" "$OFFLINE_LOG_DIR" \
    "$PILOT_HOME/plugins" "$PILOT_HOME/skills" "$PILOT_HOME/projects" \
    "$PILOT_HOME/memory" "$PILOT_HOME/cron" "$PILOT_HOME/logs" \
    "$PILOT_HOME/workspaces/general/inbox" \
    "$PILOT_HOME/workspaces/general/exports" \
    "$PILOT_HOME/workspaces/general/scratch/qa" \
    "$PILOT_HOME/workspaces/general/scratch/work" \
    "$PILOT_HOME/workspaces/general/scratch/preview"

  local med_link="$PILOT_HOME/plugins/med-tools"
  if [[ -d "$PILOTDECK_ROOT/plugins/med-tools" ]]; then
    ln -sfn "../../plugins/med-tools" "$med_link"
  fi

  if [[ ! -f "$PILOT_HOME/pilotdeck.yaml" ]]; then
    "$RUNTIME_NODE_DIR/bin/node" "$PILOTDECK_ROOT/scripts/bootstrap-pilotdeck-config.mjs"
  fi
}

pid_is_running() {
  local pid_file="$1"
  [[ -s "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}
