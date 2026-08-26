#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_SOURCE="$SKILL_DIR/runtime"
CACHE_ROOT="${PDF_SKILL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pilotdeck-pdf}"
RUNTIME_CACHE="$CACHE_ROOT/runtime"
STAMP_FILE="$RUNTIME_CACHE/.pilotdeck-requirements-hash"

find_python() {
  command -v python3 2>/dev/null || command -v python 2>/dev/null || return 1
}

venv_python() {
  if [[ -x "$RUNTIME_CACHE/bin/python" ]]; then
    printf '%s\n' "$RUNTIME_CACHE/bin/python"
    return 0
  fi
  if [[ -x "$RUNTIME_CACHE/Scripts/python.exe" ]]; then
    printf '%s\n' "$RUNTIME_CACHE/Scripts/python.exe"
    return 0
  fi
  return 1
}

find_executable() {
  local name="$1"
  shift
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  local candidate=""
  for candidate in "$@"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

find_pdfinfo() {
  find_executable pdfinfo \
    /opt/homebrew/bin/pdfinfo \
    /usr/local/bin/pdfinfo \
    /usr/bin/pdfinfo
}

find_pdftoppm() {
  find_executable pdftoppm \
    /opt/homebrew/bin/pdftoppm \
    /usr/local/bin/pdftoppm \
    /usr/bin/pdftoppm
}

runtime_hash() {
  local python_path=""
  python_path="$(venv_python || find_python)" || return 1
  "$python_path" - "$RUNTIME_SOURCE/requirements.txt" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
digest = hashlib.sha256()
digest.update(path.read_bytes())
digest.update(f"{sys.version_info.major}.{sys.version_info.minor}".encode())
print(digest.hexdigest())
PY
}

runtime_ready() {
  local python_path="" expected="" actual=""
  python_path="$(venv_python)" || return 1
  [[ -f "$STAMP_FILE" ]] || return 1
  expected="$(runtime_hash)" || return 1
  actual="$(<"$STAMP_FILE")"
  [[ "$expected" == "$actual" ]] || return 1
  "$python_path" -c 'import pdfplumber, pypdf, reportlab; from PIL import Image' >/dev/null 2>&1
}

runtime_missing_json() {
  printf '{"status":"error","error":"交付包不完整：PDF 本地运行时未就绪。请使用完整交付包，不要在现场安装依赖或自行编写 Python。"}\n'
}

poppler_missing_json() {
  printf '{"status":"error","error":"交付包不完整：缺少 Poppler（pdfinfo / pdftoppm）。请使用完整交付包。"}\n'
}

cmd_check() {
  local python_path="" runtime_python="" pdfinfo_path="" pdftoppm_path=""
  local python_ok=false deps_ok=false pdfinfo_ok=false pdftoppm_ok=false
  if python_path="$(find_python)"; then
    python_ok=true
  fi
  if runtime_ready; then
    deps_ok=true
    runtime_python="$(venv_python)"
  fi
  if pdfinfo_path="$(find_pdfinfo)"; then
    pdfinfo_ok=true
  fi
  if pdftoppm_path="$(find_pdftoppm)"; then
    pdftoppm_ok=true
  fi
  local status="missing_dependencies"
  if [[ "$python_ok" == true && "$deps_ok" == true && "$pdfinfo_ok" == true && "$pdftoppm_ok" == true ]]; then
    status="ok"
  fi
  printf '{"status":"%s","python":%s,"python_path":"%s","dependencies":%s,"runtime_python":"%s","runtime":"%s","pdfinfo":%s,"pdfinfo_path":"%s","pdftoppm":%s,"pdftoppm_path":"%s"}\n' \
    "$status" "$python_ok" "$python_path" "$deps_ok" "$runtime_python" "$RUNTIME_CACHE" \
    "$pdfinfo_ok" "$pdfinfo_path" "$pdftoppm_ok" "$pdftoppm_path"
  [[ "$status" == "ok" ]]
}

# Packager / image-build only. Never exposed in SKILL.md or agent error hints.
cmd_bootstrap_runtime() {
  local python_path="" runtime_python_path="" expected=""
  python_path="$(find_python)" || {
    printf '{"status":"error","error":"Python 3 was not found"}\n' >&2
    exit 2
  }
  [[ -f "$RUNTIME_SOURCE/requirements.txt" ]] || {
    printf '{"status":"error","error":"runtime/requirements.txt is missing"}\n' >&2
    exit 2
  }
  mkdir -p "$CACHE_ROOT"
  if [[ ! -x "$RUNTIME_CACHE/bin/python" && ! -x "$RUNTIME_CACHE/Scripts/python.exe" ]]; then
    "$python_path" -m venv "$RUNTIME_CACHE"
  fi
  runtime_python_path="$(venv_python)"
  "$runtime_python_path" -m pip install --disable-pip-version-check --no-input -r "$RUNTIME_SOURCE/requirements.txt"
  expected="$(runtime_hash)"
  printf '%s\n' "$expected" > "$STAMP_FILE"

  if ! find_pdfinfo >/dev/null || ! find_pdftoppm >/dev/null; then
    poppler_missing_json >&2
    exit 2
  fi
  cmd_check
}

case "${1:-}" in
  check)
    shift
    cmd_check "$@"
    ;;
  bootstrap-runtime)
    shift
    cmd_bootstrap_runtime "$@"
    ;;
  fix)
    printf '{"status":"error","error":"pdf.sh 不支持现场安装。请使用完整交付包，不要 pip，不要自行编写 Python。"}\n' >&2
    exit 2
    ;;
  ""|-h|--help|help)
    printf 'Usage: pdf.sh <check|make|inspect|audit|render|merge|split|rotate|forms-inspect|forms-fill|self-test> [options]\n'
    ;;
  *)
    if ! runtime_ready; then
      runtime_missing_json >&2
      exit 2
    fi
    pdfinfo_path="$(find_pdfinfo || true)"
    pdftoppm_path="$(find_pdftoppm || true)"
    if [[ -z "$pdfinfo_path" || -z "$pdftoppm_path" ]]; then
      poppler_missing_json >&2
      exit 2
    fi
    export PDF_SKILL_ROOT="$SKILL_DIR"
    export PDF_SKILL_PDFINFO="$pdfinfo_path"
    export PDF_SKILL_PDFTOPPM="$pdftoppm_path"
    exec "$(venv_python)" "$SCRIPT_DIR/pdf_cli.py" "$@"
    ;;
esac
