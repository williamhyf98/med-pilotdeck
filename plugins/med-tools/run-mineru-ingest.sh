#!/usr/bin/env bash
# Launch the MinerU ingest MCP server (stdio). Used by PilotDeck plugin.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${ROOT}/.venv/bin/python"
if [[ ! -x "${PYTHON}" ]]; then
  echo "mineru-ingest-tools: missing venv at ${PYTHON}. Run: ${ROOT}/setup.sh" >&2
  exit 1
fi

CONFIG_FILE="${MED_RAG_MINERU_CONFIG_FILE:-${PILOT_HOME:-}/med-tools/mineru-ingest.env}"
if [[ -n "${CONFIG_FILE}" && -f "${CONFIG_FILE}" ]]; then
  # Deployment-specific MinerU paths stay outside Git. The file uses ordinary
  # shell KEY=VALUE assignments; export all values for the MCP child process.
  set -a
  # shellcheck disable=SC1090
  source "${CONFIG_FILE}"
  set +a
fi

cd "${ROOT}"
export MED_RAG_MINERU_MCP_TRANSPORT="stdio"
exec "${PYTHON}" -m server.mineru_ingest_app "$@"
