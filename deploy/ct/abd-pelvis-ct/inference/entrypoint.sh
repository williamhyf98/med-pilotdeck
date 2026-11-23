#!/bin/sh
set -eu

export RADAR_SERVICE_ROOT="${RADAR_SERVICE_ROOT:-/opt/abd-pelvis-ct/inference}"
export RADAR_ROOT="${RADAR_ROOT:-$RADAR_SERVICE_ROOT/damo-radar}"
export RADAR_MODEL_ROOT="${RADAR_MODEL_ROOT:-$RADAR_SERVICE_ROOT/models}"
export RADAR_GPU_WORK_ROOT="${ABD_PELVIS_CT_INFERENCE_WORK_ROOT:-/var/lib/abd-pelvis-ct/inference}"
export RADAR_DEVICE="${ABD_PELVIS_CT_DEVICE:-cuda:0}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-${ABD_PELVIS_CT_GPU:-0}}"

mkdir -p "$RADAR_GPU_WORK_ROOT"
exec python3 gpu_api.py --host 0.0.0.0 --port 18221
