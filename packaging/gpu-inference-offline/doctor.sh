#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
for model in radar deepchest; do
  if [[ "$model" == radar ]]; then
    interpreter="$PACKAGE_ROOT/python/3.10/bin/python3.10"
    export PYTHONPATH="$PACKAGE_ROOT/runtime/radar/site-packages"
    export CUDA_VISIBLE_DEVICES="$RADAR_GPU"
  else
    interpreter="$PACKAGE_ROOT/python/3.12/bin/python3.12"
    export PYTHONPATH="$PACKAGE_ROOT/runtime/deepchest/site-packages:$PACKAGE_ROOT/deepchest/third_party/CT-CLIP-official/CT_CLIP:$PACKAGE_ROOT/deepchest/third_party/CT-CLIP-official/transformer_maskgit"
    unset CUDA_VISIBLE_DEVICES
  fi
  echo "== $model =="
  "$interpreter" - <<'PY'
import importlib, sys
print("Python", sys.version.split()[0])
for name in ("torch", "torchvision", "fastapi", "uvicorn", "monai", "totalsegmentator", "ct_clip", "transformer_maskgit"):
    try:
        mod = importlib.import_module(name)
        print(name, getattr(mod, "__version__", "import ok"))
        if name == "torch":
            print("torch CUDA build:", mod.version.cuda)
            print("CUDA visible:", mod.cuda.is_available(), "count:", mod.cuda.device_count())
    except Exception as exc:
        print(name, type(exc).__name__, str(exc)[:250])
PY
done
