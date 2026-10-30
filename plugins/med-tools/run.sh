#!/usr/bin/env bash
# Launch the med-tools MCP server (stdio). Used by PilotDeck plugin.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Venv layout differs per platform: POSIX uses bin/, Windows uses Scripts/.
if [[ -x "${ROOT}/.venv/bin/python" ]]; then
  PYTHON="${ROOT}/.venv/bin/python"
elif [[ -x "${ROOT}/.venv/Scripts/python.exe" ]]; then
  PYTHON="${ROOT}/.venv/Scripts/python.exe"
else
  echo "med-tools: missing venv at ${ROOT}/.venv. Run: ${ROOT}/setup.sh" >&2
  exit 1
fi
cd "${ROOT}"
exec "${PYTHON}" -m server "$@"
