#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/offline-runtime.sh"

prepare_environment

[[ -x "$RUNTIME_PYTHON_DIR/bin/python3" || -x "$RUNTIME_PYTHON_DIR/bin/python" ]] || {
  echo "error: bundled Linux ARM64 Python is missing: $RUNTIME_PYTHON_DIR" >&2
  exit 1
}
[[ -d "$PYTHON_WHEELS_DIR" ]] || {
  echo "error: offline Python wheel directory is missing: $PYTHON_WHEELS_DIR" >&2
  exit 1
}

create_venv() {
  local target="$1"
  local requirements="$2"
  local python_bin="$RUNTIME_PYTHON_DIR/bin/python3"
  [[ -x "$python_bin" ]] || python_bin="$RUNTIME_PYTHON_DIR/bin/python"

  if [[ ! -x "$target/bin/python" ]]; then
    rm -rf "$target"
    "$python_bin" -m venv "$target"
  fi
  "$target/bin/python" -m pip install \
    --disable-pip-version-check \
    --no-index \
    --find-links "$PYTHON_WHEELS_DIR" \
    -r "$requirements"
}

create_venv "$PILOTDECK_ROOT/plugins/med-tools/.venv" \
  "$PILOTDECK_ROOT/plugins/med-tools/requirements.txt"

# The document skills use their own cache locations. Their bootstrap commands
# are packager-only in normal deployments, so this call is safe offline.
export PDF_SKILL_CACHE="$XDG_CACHE_HOME/pilotdeck-pdf"
export DOCX_SKILL_CACHE="$XDG_CACHE_HOME/pilotdeck-docx"
bash "$PILOTDECK_ROOT/skills/pdf/scripts/pdf.sh" bootstrap-runtime >/dev/null
bash "$PILOTDECK_ROOT/skills/docx/scripts/docx.sh" bootstrap-runtime >/dev/null

echo "offline Python runtimes are ready under $PILOT_HOME and $XDG_CACHE_HOME"
