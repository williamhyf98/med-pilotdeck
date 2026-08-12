#!/usr/bin/env bash
# Launch the med-tools MCP server (stdio). Used by PilotDeck plugin.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${ROOT}/.venv/bin/python"
if [[ ! -x "${PYTHON}" ]]; then
  echo "med-tools: missing venv at ${PYTHON}. Run: ${ROOT}/setup.sh" >&2
  exit 1
fi
cd "${ROOT}"
exec "${PYTHON}" -m server "$@"
