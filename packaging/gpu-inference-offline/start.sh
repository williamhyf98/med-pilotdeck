#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
case "${1:-}" in
  radar)
    export RADAR_SERVICE_ROOT="$PACKAGE_ROOT/radar"
    export RADAR_ROOT="$PACKAGE_ROOT/radar/damo-radar"
    export RADAR_MODEL_ROOT="$PACKAGE_ROOT/radar/models"
    export RADAR_TEXT_EMBEDDING="$PACKAGE_ROOT/radar/damo-radar/ckpt/infer_text_embedding_radar.pt"
    export RADAR_GPU_WORK_ROOT="$PACKAGE_ROOT/private/work/radar"
    export CUDA_VISIBLE_DEVICES="$RADAR_GPU" RADAR_DEVICE=cuda:0
    export PYTHONPATH="$PACKAGE_ROOT/runtime/radar/site-packages"
    cd "$PACKAGE_ROOT/radar"
    exec "$PACKAGE_ROOT/python/3.10/bin/python3.10" gpu_api.py --host "$RADAR_BIND" --port "$RADAR_PORT"
    ;;
  deepchest)
    export MED_DEEPCHEST_ROOT="$PACKAGE_ROOT/deepchest"
    export DEEPCHEST_INFERENCE_WORK_ROOT="$PACKAGE_ROOT/private/work/deepchest"
    export DEEPCHEST_INFERENCE_LOG_ROOT="$PACKAGE_ROOT/private/logs/deepchest"
    export PYTHONPATH="$PACKAGE_ROOT/runtime/deepchest/site-packages:$PACKAGE_ROOT/deepchest/third_party/CT-CLIP-official/CT_CLIP:$PACKAGE_ROOT/deepchest/third_party/CT-CLIP-official/transformer_maskgit"
    # DeepChest 自行将物理 GPU 编号映射至其子进程的 cuda:0。
    unset CUDA_VISIBLE_DEVICES
    cd "$PACKAGE_ROOT/deepchest/service"
    exec "$PACKAGE_ROOT/python/3.12/bin/python3.12" -m uvicorn deepchest_service.inference_api:app --host "$DEEPCHEST_BIND" --port "$DEEPCHEST_PORT" --workers 1
    ;;
  *)
    echo "用法：$0 {radar|deepchest}" >&2
    exit 2
    ;;
esac
