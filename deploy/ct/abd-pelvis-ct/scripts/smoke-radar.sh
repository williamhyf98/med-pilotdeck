#!/bin/sh
set -eu

BASE_URL="${ABD_PELVIS_CT_GATEWAY_URL:-http://127.0.0.1:18120}"
INPUT="${1:?usage: smoke-radar.sh <de-identified-ct.nii|nii.gz|zip>}"

if [ ! -f "$INPUT" ]; then
  echo "input not found: $INPUT" >&2
  exit 2
fi

echo "POST ${BASE_URL}/v1/analyze"
curl --fail-with-body --max-time 900 \
  -F "file=@${INPUT}" \
  -F "top_k=5" \
  -F "threshold=0.5" \
  -F "max_cases=1" \
  -F "study_context=abd-pelvis-ct smoke" \
  "${BASE_URL}/v1/analyze"
