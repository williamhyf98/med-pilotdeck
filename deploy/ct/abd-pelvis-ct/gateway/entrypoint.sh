#!/bin/sh
set -eu

export RADAR_SERVICE_ROOT="${RADAR_SERVICE_ROOT:-/opt/abd-pelvis-ct/gateway}"
export RADAR_HELPER_ROOT="${RADAR_HELPER_ROOT:-$RADAR_SERVICE_ROOT}"
export RADAR_WORK_ROOT="${ABD_PELVIS_CT_GATEWAY_WORK_ROOT:-/var/lib/abd-pelvis-ct/gateway}"
export RADAR_INFERENCE_API_BASE="${ABD_PELVIS_CT_INFERENCE_API_BASE:?ABD_PELVIS_CT_INFERENCE_API_BASE is required}"
export RADAR_DEVICE="${ABD_PELVIS_CT_DEVICE:-cuda:0}"

mkdir -p "$RADAR_WORK_ROOT"
exec python app.py --host 0.0.0.0 --port 18120
