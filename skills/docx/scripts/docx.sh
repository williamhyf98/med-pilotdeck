#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REQUIREMENTS="$SKILL_DIR/requirements.txt"
CACHE_ROOT="${DOCX_SKILL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pilotdeck-docx}"
VENV_DIR="$CACHE_ROOT/venv"
STAMP_FILE="$VENV_DIR/.pilotdeck-requirements-hash"
BUNDLED_FONT_DIR="${DOCX_SKILL_FONT_DIR:-$SKILL_DIR/../pdf/assets/fonts}"

venv_python() {
  if [[ -x "$VENV_DIR/bin/python" ]]; then
    printf '%s\n' "$VENV_DIR/bin/python"
    return 0
  fi
  if [[ -x "$VENV_DIR/Scripts/python.exe" ]]; then
    printf '%s\n' "$VENV_DIR/Scripts/python.exe"
    return 0
  fi
  return 1
}

find_python() {
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    command -v python
    return 0
  fi
  return 1
}

runtime_hash() {
  local python_path=""
  python_path="$(venv_python || find_python)" || return 1
  "$python_path" - "$REQUIREMENTS" <<'PY'
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
  [[ -f "$BUNDLED_FONT_DIR/NotoSansSC-VF.ttf" ]] || return 1
  "$python_path" -c 'import docx, lxml, PIL' >/dev/null 2>&1
}

runtime_missing_json() {
  printf '{"status":"error","code":"missing-dependencies","error":"交付包不完整：DOCX 本地运行时未就绪。请使用完整交付包，不要在现场安装依赖或自行编写 Python。"}\n'
}

find_soffice() {
  local mac_path="/Applications/LibreOffice.app/Contents/MacOS/soffice"
  if [[ -x "$mac_path" ]]; then
    printf '%s\n' "$mac_path"
    return 0
  fi
  if command -v soffice >/dev/null 2>&1; then
    command -v soffice
    return 0
  fi
  local windows_path="/c/Program Files/LibreOffice/program/soffice.exe"
  if [[ -x "$windows_path" ]]; then
    printf '%s\n' "$windows_path"
    return 0
  fi
  return 1
}

cmd_check() {
  local py=""
  local py_ok=false
  local deps_ok=false
  local render_deps_ok=false
  local font_ok=false
  local soffice_path=""
  if py="$(find_python)"; then
    py_ok=true
  fi
  if runtime_ready; then
    deps_ok=true
    py="$(venv_python)"
    if "$py" -c 'import pymupdf' >/dev/null 2>&1; then
      render_deps_ok=true
    fi
  fi
  if [[ -f "$BUNDLED_FONT_DIR/NotoSansSC-VF.ttf" ]]; then
    font_ok=true
  fi
  if ! soffice_path="$(find_soffice)"; then
    soffice_path=""
  fi
  printf '{"status":"%s","code":"%s","python":%s,"python_path":"%s","dependencies":%s,"venv":"%s","bundled_font":%s,"bundled_font_dir":"%s","libreoffice":%s,"libreoffice_path":"%s","render_dependencies":%s,"render_available":%s}\n' \
    "$([[ "$py_ok" == true && "$deps_ok" == true && "$font_ok" == true ]] && printf ok || printf error)" \
    "$([[ "$py_ok" == true && "$deps_ok" == true && "$font_ok" == true ]] && printf dependencies-ready || printf missing-dependencies)" \
    "$py_ok" "$py" "$deps_ok" "$VENV_DIR" \
    "$font_ok" "$BUNDLED_FONT_DIR" \
    "$([[ -n "$soffice_path" ]] && printf true || printf false)" "$soffice_path" \
    "$render_deps_ok" \
    "$([[ -n "$soffice_path" && "$deps_ok" == true && "$render_deps_ok" == true && "$font_ok" == true ]] && printf true || printf false)"
  [[ "$py_ok" == true && "$deps_ok" == true && "$font_ok" == true ]]
}

cmd_bootstrap_runtime() {
  local bootstrap=""
  if command -v python3 >/dev/null 2>&1; then
    bootstrap="$(command -v python3)"
  elif command -v python >/dev/null 2>&1; then
    bootstrap="$(command -v python)"
  else
    printf '{"status":"error","code":"python-not-found","error":"Python 3 was not found"}\n' >&2
    exit 2
  fi
  [[ -f "$REQUIREMENTS" ]] || {
    printf '{"status":"error","code":"requirements-not-found","error":"requirements.txt is missing"}\n' >&2
    exit 2
  }
  mkdir -p "$CACHE_ROOT"
  if [[ ! -x "$VENV_DIR/bin/python" && ! -x "$VENV_DIR/Scripts/python.exe" ]]; then
    "$bootstrap" -m venv "$VENV_DIR"
  fi
  local venv_py=""
  if ! venv_py="$(venv_python)"; then
    printf '{"status":"error","code":"venv-python-not-found","error":"Virtual environment was created without a usable Python executable"}\n' >&2
    exit 2
  fi
  "$venv_py" -m pip install --disable-pip-version-check --no-input -r "$REQUIREMENTS"
  runtime_hash > "$STAMP_FILE"
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
    printf '{"status":"error","code":"offline-install-disabled","error":"docx.sh 不支持现场安装。请使用完整交付包，不要 pip，不要自行编写 Python。"}\n' >&2
    exit 2
    ;;
  ""|-h|--help|help)
    py=""
    if ! py="$(venv_python)"; then
      py=""
    fi
    if [[ -n "$py" ]]; then
      exec "$py" "$SCRIPT_DIR/docx_cli.py" --help
    fi
    printf 'Usage: docx.sh <check|make|inspect|edit|review|finalize|compare|sanitize|render|refresh-toc|validate|audit|preflight|deliver|resolve-latest|self-test> [options]\n'
    ;;
  *)
    if ! runtime_ready; then
      runtime_missing_json >&2
      exit 2
    fi
    py="$(venv_python)"
    soffice_path=""
    if ! soffice_path="$(find_soffice)"; then
      soffice_path=""
    fi
    export DOCX_SKILL_SOFFICE="$soffice_path"
    export DOCX_SKILL_FONT_DIR="$BUNDLED_FONT_DIR"
    exec "$py" "$SCRIPT_DIR/docx_cli.py" "$@"
    ;;
esac
