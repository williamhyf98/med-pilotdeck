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
if ! "${PYTHON_BIN}" -c "import sys" >/dev/null 2>&1; then
  echo "error: cannot run ${PYTHON_BIN}. On Windows, pass a real interpreter:" >&2
  echo "  PYTHON_BIN='D:/path/to/python.exe' bash setup.sh" >&2
  exit 1
fi
if [[ ! -d .venv ]]; then
  "${PYTHON_BIN}" -m venv .venv
fi
# Venv layout differs per platform: POSIX uses bin/, Windows uses Scripts/.
if [[ -x ".venv/bin/python" ]]; then
  VENV_PY=".venv/bin/python"
elif [[ -x ".venv/Scripts/python.exe" ]]; then
  VENV_PY=".venv/Scripts/python.exe"
else
  echo "error: venv python not found under .venv" >&2
  exit 1
fi
# Prefer a China mirror when available; fall back to default PyPI.
INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
"${VENV_PY}" -m pip install -U pip
"${VENV_PY}" -m pip install -r requirements.txt -i "${INDEX_URL}"

chmod +x "${ROOT}/run.sh"
echo "med-tools setup complete: ${ROOT}/.venv (${VENV_PY})"
"${VENV_PY}" -c "import mcp, pydicom, PIL, numpy, httpx; print('imports ok')"
