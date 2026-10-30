#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /absolute/path/to/sample.pdf" >&2
  exit 2
fi

: "${MED_RAG_MINERU_LAUNCHER:?set MED_RAG_MINERU_LAUNCHER to the fixed node12 Python launcher}"
: "${MED_RAG_MINERU_MODEL_ROOT:?set MED_RAG_MINERU_MODEL_ROOT to the local pipeline model directory}"

source_pdf=$1
if [[ ! -f "$source_pdf" ]]; then
  echo "input PDF does not exist" >&2
  exit 2
fi

output_root=$(mktemp -d "${TMPDIR:-/tmp}/mineru-cli-smoke.XXXXXX")
trap 'rm -rf "$output_root"' EXIT
smoke_home="$output_root/.mineru-home"
mkdir -p "$smoke_home"/{cache,config,hf-cache,tmp}
python3 - "$MED_RAG_MINERU_MODEL_ROOT" "$smoke_home/mineru.json" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[2]).write_text(
    json.dumps({"models-dir": {"pipeline": str(Path(sys.argv[1]).resolve())}}),
    encoding="utf-8",
)
PY

python_bin=$(python3 - "$MED_RAG_MINERU_LAUNCHER" <<'PY'
import shlex
import sys

print(shlex.split(sys.argv[1])[0])
PY
)
HOME="$smoke_home" \
XDG_CACHE_HOME="$smoke_home/cache" \
XDG_CONFIG_HOME="$smoke_home/config" \
HF_HOME="$smoke_home/hf-cache" \
TMPDIR="$smoke_home/tmp" \
PYTHONNOUSERSITE=1 \
MINERU_MODEL_SOURCE=local \
MINERU_TOOLS_CONFIG_JSON="$smoke_home/mineru.json" \
"$python_bin" -m mineru.cli.client \
  -p "$source_pdf" \
  -o "$output_root" \
  -m ocr \
  -b pipeline \
  -l ch \
  -f false \
  -t false \
  -d "${MED_RAG_MINERU_DEFAULT_DEVICE:-cuda}" \
  --source local

stem=$(basename "$source_pdf" .pdf)
parsed="$output_root/$stem/ocr"
for artifact in "$parsed/$stem.md" "$parsed/${stem}_content_list.json" "$parsed/${stem}_model.json"; do
  [[ -s "$artifact" ]] || {
    echo "missing MinerU artifact: $(basename "$artifact")" >&2
    exit 1
  }
done

echo "MinerU CLI smoke succeeded: $parsed"
