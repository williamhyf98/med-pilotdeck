#!/usr/bin/env bash
# Create/update the plugin venv and install Python dependencies.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}"

# Prefer project-local portable CPython when present (see scripts/bootstrap-runtime.sh).
if [[ -z "${PYTHON_BIN:-}" ]]; then
  _pd_root="$(cd "${ROOT}/../.." && pwd)"
  if [[ -x "${_pd_root}/.runtime/python/bin/python3" ]]; then
    PYTHON_BIN="${_pd_root}/.runtime/python/bin/python3"
  elif [[ -x "${_pd_root}/.runtime/python/bin/python" ]]; then
    PYTHON_BIN="${_pd_root}/.runtime/python/bin/python"
  else
    PYTHON_BIN="python3"
  fi
fi
if [[ ! -d .venv ]]; then
  "${PYTHON_BIN}" -m venv .venv
fi
# Prefer a China mirror when available; fall back to default PyPI.
INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements.txt -i "${INDEX_URL}"

chmod +x "${ROOT}/run.sh"
echo "med-tools setup complete: ${ROOT}/.venv"
.venv/bin/python -c "import mcp, pydicom, PIL, numpy, httpx; print('imports ok')"
