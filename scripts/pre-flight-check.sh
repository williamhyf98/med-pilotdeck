#!/usr/bin/env bash
# Check the login-mode sandbox dependency before starting a UI service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The UI also loads config/deploy.env. Read only the auth flag here so the
# pre-flight check cannot disagree with the mode selected by that file.
auth_mode_from_deploy_env() {
  local file="${PILOTDECK_DEPLOY_ENV:-${SCRIPT_DIR}/../config/deploy.env}"
  [[ -f "$file" ]] || return 0

  local raw key value mode=""
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%$'\r'}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    [[ "$raw" == export\ * ]] && raw="${raw#export }"
    [[ "$raw" == *=* ]] || continue
    key="${raw%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" == "PILOTDECK_DISABLE_LOCAL_AUTH" ]] || continue
    value="${raw#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value#\"}"
      value="${value%\"}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value#\'}"
      value="${value%\'}"
    fi
    mode="$value"
  done < "$file"
  printf '%s' "$mode"
}

mode="${PILOTDECK_DISABLE_LOCAL_AUTH:-}"
if [[ -z "$mode" ]]; then
  mode="$(auth_mode_from_deploy_env)"
fi

if [[ "$mode" != "0" && "$mode" != "false" ]]; then
  echo "[pre-flight] No-login mode, sandbox not required"
  exit 0
fi

echo "[pre-flight] Multi-user mode enabled, checking sandbox..."
case "$(uname -s)" in
  Linux)
    if ! command -v bwrap >/dev/null 2>&1; then
      echo "ERROR: Multi-user mode on Linux requires bubblewrap, but 'bwrap' not found." >&2
      echo "Install with:" >&2
      echo "  sudo apt install bubblewrap       # Debian/Ubuntu" >&2
      echo "  sudo yum install bubblewrap       # CentOS/RHEL" >&2
      echo "  sudo pacman -S bubblewrap         # Arch" >&2
      echo "For local no-login development only, unset PILOTDECK_DISABLE_LOCAL_AUTH." >&2
      exit 1
    fi
    echo "[pre-flight] bubblewrap found: $(command -v bwrap)"
    ;;
  Darwin)
    echo "[pre-flight] macOS detected, sandbox-exec will be used (development only)"
    ;;
  *)
    echo "ERROR: Multi-user mode requires a supported OS sandbox (Linux bwrap or macOS sandbox-exec)." >&2
    exit 1
    ;;
esac
