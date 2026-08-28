#!/usr/bin/env bash
# Shared helpers for PilotDeck project-local runtime (no ultrafast_share).
# shellcheck shell=bash

_PILOTDECK_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PILOTDECK_ROOT="$(cd "$_PILOTDECK_LIB_DIR/.." && pwd)"
RUNTIME_DIR="${PILOTDECK_ROOT}/.runtime"
RUNTIME_NODE_DIR="${RUNTIME_DIR}/node"
RUNTIME_PYTHON_DIR="${RUNTIME_DIR}/python"
RUNTIME_CACHE_DIR="${RUNTIME_DIR}/cache"
RUNTIME_DOWNLOADS_DIR="${RUNTIME_DIR}/downloads"
RUNTIME_TMP_DIR="${RUNTIME_CACHE_DIR}/tmp"
RUNTIME_NPM_CACHE="${RUNTIME_CACHE_DIR}/npm"
RUNTIME_PNPM_STORE="${RUNTIME_CACHE_DIR}/pnpm-store"
RUNTIME_PIP_CACHE="${RUNTIME_CACHE_DIR}/pip"
PILOT_HOME_DIR="${PILOTDECK_ROOT}/.pilotdeck-home"
LOCAL_PORT_CONFIG="${_PILOTDECK_LIB_DIR}/config.env"

# Load SERVER_PORT / PILOTDECK_GATEWAY_PORT / VITE_PORT from scripts/config.env.
# Existing environment variables are left unchanged.
load_local_port_config() {
  local conf="${LOCAL_PORT_CONFIG}"
  if [[ ! -f "$conf" ]]; then
    echo "error: missing port config: ${conf}" >&2
    return 1
  fi

  local key raw value current
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%$'\r'}"
    [[ -z "${raw}" || "${raw}" =~ ^[[:space:]]*# ]] && continue
    key="${raw%%=*}"
    value="${raw#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#"${key%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value#\"}"
      value="${value%\"}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value#\'}"
      value="${value%\'}"
    fi
    case "$key" in
      SERVER_PORT|PILOTDECK_GATEWAY_PORT|VITE_PORT)
        current="${!key:-}"
        if [[ -z "$current" ]]; then
          export "${key}=${value}"
        fi
        ;;
    esac
  done < "$conf"

  export SERVER_PORT="${SERVER_PORT:-3010}"
  export PILOTDECK_GATEWAY_PORT="${PILOTDECK_GATEWAY_PORT:-18789}"
  export VITE_PORT="${VITE_PORT:-5173}"
}

load_local_port_config

NODE_VERSION_DEFAULT="22.23.2"
# astral/python-build-standalone pin (install_only_stripped)
PY_STANDALONE_TAG_DEFAULT="20260325"
PY_STANDALONE_VERSION_DEFAULT="3.12.13"

FORBIDDEN_PATH_SUBSTR="ultrafast_share"
FORBIDDEN_LEGACY_HOME="${HOME}/.pilotdeck"

path_has_forbidden() {
  local value="${1:-}"
  [[ "$value" == *"${FORBIDDEN_PATH_SUBSTR}"* ]]
}

strip_forbidden_from_path() {
  local input="${1:-}"
  local out="" part
  IFS=':' read -r -a parts <<<"$input"
  for part in "${parts[@]}"; do
    [[ -z "$part" ]] && continue
    if path_has_forbidden "$part"; then
      continue
    fi
    if [[ -z "$out" ]]; then
      out="$part"
    else
      out="${out}:${part}"
    fi
  done
  printf '%s' "$out"
}

ensure_runtime_dirs() {
  mkdir -p \
    "$RUNTIME_DOWNLOADS_DIR" \
    "$RUNTIME_TMP_DIR" \
    "$RUNTIME_NPM_CACHE" \
    "$RUNTIME_PNPM_STORE" \
    "$RUNTIME_PIP_CACHE"
}

# Empty (or existing) project-local Pilot home; link in-repo med-tools plugin.
ensure_project_pilot_home() {
  mkdir -p \
    "${PILOT_HOME_DIR}/plugins" \
    "${PILOT_HOME_DIR}/skills" \
    "${PILOT_HOME_DIR}/projects" \
    "${PILOT_HOME_DIR}/memory" \
    "${PILOT_HOME_DIR}/cron" \
    "${PILOT_HOME_DIR}/logs" \
    "${PILOT_HOME_DIR}/workspaces/general/inbox" \
    "${PILOT_HOME_DIR}/workspaces/general/exports" \
    "${PILOT_HOME_DIR}/workspaces/general/scratch/qa" \
    "${PILOT_HOME_DIR}/workspaces/general/scratch/work" \
    "${PILOT_HOME_DIR}/workspaces/general/scratch/preview"

  local med_src="${PILOTDECK_ROOT}/plugins/med-tools"
  local med_link="${PILOT_HOME_DIR}/plugins/med-tools"
  if [[ -d "$med_src" ]]; then
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        # Windows: `ln -s` needs dev mode and otherwise silently deep-copies
        # the plugin (~400MB). Use a directory junction (no admin needed).
        if [[ -L "$med_link" || -d "$med_link" ]]; then
          rm -rf "$med_link"
        fi
        local win_med_link win_med_src
        win_med_link="$(cygpath -w "$med_link")"
        win_med_src="$(cygpath -w "$med_src")"
        if powershell -NoProfile -Command "New-Item -ItemType Junction -Path '${win_med_link}' -Target '${win_med_src}' | Out-Null" 2>/dev/null \
          && [[ -f "$med_link/plugin.json" ]]; then
          :
        else
          echo "warn: junction failed for med-tools; falling back to copy" >&2
          cp -r "$med_src" "$med_link"
        fi
        ;;
      *)
        ln -sfn "$med_src" "$med_link"
        ;;
    esac
  fi
}

# Export env so Node/npm/pnpm/pip/temp never touch ultrafast_share.
apply_local_runtime_env() {
  ensure_runtime_dirs
  ensure_project_pilot_home

  export PILOTDECK_ROOT
  export PILOT_HOME="$PILOT_HOME_DIR"
  export PILOTDECK_CONFIG_DIR="$PILOT_HOME_DIR"
  # Clear stale overrides from the parent shell that would pin state to ~/.pilotdeck.
  unset DATABASE_PATH PILOTDECK_CONFIG_PATH PILOTDECK_GATEWAY_TOKEN_PATH 2>/dev/null || true
  export PILOTDECK_TMPDIR="$RUNTIME_TMP_DIR"
  export TMPDIR="$RUNTIME_TMP_DIR"
  export TMP="$RUNTIME_TMP_DIR"
  export TEMP="$RUNTIME_TMP_DIR"

  export npm_config_cache="$RUNTIME_NPM_CACHE"
  export NPM_CONFIG_CACHE="$RUNTIME_NPM_CACHE"
  export npm_config_devdir="${RUNTIME_CACHE_DIR}/node-gyp"
  export PNPM_STORE_PATH="$RUNTIME_PNPM_STORE"
  export PIP_CACHE_DIR="$RUNTIME_PIP_CACHE"
  export UV_CACHE_DIR="${RUNTIME_CACHE_DIR}/uv"
  export XDG_CACHE_HOME="${RUNTIME_CACHE_DIR}/xdg"

  # Drop share-backed conda / global npm prefixes from influence.
  unset CONDA_PKGS_DIRS CONDA_ENVS_PATH CONDA_PREFIX CONDA_DEFAULT_ENV CONDA_PROMPT_MODIFIER 2>/dev/null || true
  unset BUNDLE_PATH BUN_INSTALL_CACHE_DIR CARGO_TARGET_DIR CCACHE_DIR COMPOSER_HOME \
    CP_HOME_DIR CYPRESS_CACHE_FOLDER GEM_SPEC_CACHE GOCACHE GOMODCACHE GRADLE_USER_HOME \
    HOMEBREW_CACHE NUGET_PACKAGES NX_CACHE_DIRECTORY PLAYWRIGHT_BROWSERS_PATH \
    POETRY_CACHE_DIR PUPPETEER_CACHE_DIR TURBO_CACHE_DIR YARN_CACHE_FOLDER 2>/dev/null || true

  local cleaned_path
  cleaned_path="$(strip_forbidden_from_path "${PATH:-}")"
  export PATH="${RUNTIME_NODE_DIR}/bin:${RUNTIME_PYTHON_DIR}/bin:${cleaned_path}"
}

assert_no_share() {
  local names=(
    PATH TMPDIR TMP TEMP PILOTDECK_TMPDIR
    NPM_CONFIG_CACHE npm_config_cache npm_config_devdir
    PNPM_STORE_PATH PIP_CACHE_DIR UV_CACHE_DIR XDG_CACHE_HOME
    PILOT_HOME PILOTDECK_CONFIG_DIR
  )
  local name val
  for name in "${names[@]}"; do
    val="${!name:-}"
    if path_has_forbidden "$val"; then
      echo "error: ${name} still references ${FORBIDDEN_PATH_SUBSTR}: ${val}" >&2
      return 1
    fi
  done

  if [[ -z "${PILOT_HOME:-}" ]]; then
    echo "error: PILOT_HOME is unset" >&2
    return 1
  fi
  case "${PILOT_HOME}" in
    "${PILOTDECK_ROOT}"/*) ;;
    *)
      echo "error: PILOT_HOME must be under project root (${PILOTDECK_ROOT}), got: ${PILOT_HOME}" >&2
      return 1
      ;;
  esac
  if [[ "${PILOT_HOME}" == "${FORBIDDEN_LEGACY_HOME}" ]]; then
    echo "error: PILOT_HOME must not be the legacy ~/.pilotdeck path" >&2
    return 1
  fi

  local node_bin python_bin
  node_bin="$(command -v node 2>/dev/null || true)"
  python_bin="$(command -v python3 2>/dev/null || true)"
  if [[ -n "$node_bin" ]] && path_has_forbidden "$(readlink -f "$node_bin" 2>/dev/null || echo "$node_bin")"; then
    echo "error: node resolves under ${FORBIDDEN_PATH_SUBSTR}: ${node_bin}" >&2
    return 1
  fi
  if [[ -n "$python_bin" ]] && path_has_forbidden "$(readlink -f "$python_bin" 2>/dev/null || echo "$python_bin")"; then
    echo "error: python3 resolves under ${FORBIDDEN_PATH_SUBSTR}: ${python_bin}" >&2
    return 1
  fi
}

runtime_node() {
  echo "${RUNTIME_NODE_DIR}/bin/node"
}

runtime_python() {
  if [[ -x "${RUNTIME_PYTHON_DIR}/bin/python3" ]]; then
    echo "${RUNTIME_PYTHON_DIR}/bin/python3"
  else
    echo "${RUNTIME_PYTHON_DIR}/bin/python"
  fi
}

download_file() {
  local url="$1"
  local dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$dest" "$url"
  else
    echo "error: need curl or wget to download ${url}" >&2
    return 1
  fi
}
