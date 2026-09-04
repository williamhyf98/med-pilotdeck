#!/usr/bin/env bash
# Launch the optional MinerU ingest MCP server over Streamable HTTP.
# It intentionally runs in the foreground; callers choose whether to manage it
# with systemd, supervisord, tmux, or a project-local process manager.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${ROOT}/.venv/bin/python"
if [[ ! -x "${PYTHON}" ]]; then
  echo "mineru-ingest-tools: missing venv at ${PYTHON}. Run: ${ROOT}/setup.sh" >&2
  exit 1
fi

CONFIG_FILE="${MED_RAG_MINERU_CONFIG_FILE:-${PILOT_HOME:-}/med-tools/mineru-ingest.env}"
if [[ -n "${CONFIG_FILE}" && -f "${CONFIG_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "${CONFIG_FILE}"
  set +a
fi

: "${MED_RAG_MINERU_MCP_HOST:=127.0.0.1}"
: "${MED_RAG_MINERU_MCP_PORT:=18890}"
export MED_RAG_MINERU_MCP_HOST MED_RAG_MINERU_MCP_PORT
export MED_RAG_MINERU_MCP_TRANSPORT="streamable-http"

cd "${ROOT}"
exec "${PYTHON}" -m server.mineru_ingest_http_app "$@"
