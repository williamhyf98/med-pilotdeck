#!/usr/bin/env bash
# Dispatch project-local runtime bootstrap by OS.
#   Linux  -> scripts/bootstrap-runtime.sh
#   macOS  -> scripts/bootstrap-runtime-darwin.sh
#
# Usage:
#   bash scripts/bootstrap-runtime-select.sh
#   PILOTDECK_BOOTSTRAP_FORCE=1 bash scripts/bootstrap-runtime-select.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
os="$(uname -s)"

case "$os" in
  Linux)
    echo "==> Detected Linux → bootstrap-runtime.sh"
    exec bash "${SCRIPT_DIR}/bootstrap-runtime.sh" "$@"
    ;;
  Darwin)
    echo "==> Detected macOS → bootstrap-runtime-darwin.sh"
    exec bash "${SCRIPT_DIR}/bootstrap-runtime-darwin.sh" "$@"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows (Git Bash): no portable runtime download — use the system Node.
    # start-local.sh verifies Node 22 itself.
    if ! command -v node >/dev/null 2>&1; then
      echo "error: node not found in PATH (install Node.js 22 first)" >&2
      exit 1
    fi
    echo "==> Windows (Git Bash): skipping portable runtime bootstrap"
    echo "    node: $(node -v)"
    ;;
  *)
    echo "error: unsupported OS '${os}'." >&2
    echo "  supported: Linux (bootstrap-runtime.sh), macOS (bootstrap-runtime-darwin.sh), Windows (Git Bash, system Node)" >&2
    exit 1
    ;;
esac
