#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
if [[ $# -ne 2 || ! -f "$2" ]]; then
  echo "用法：$0 {radar|deepchest} /绝对路径/测试CT.nii.gz" >&2
  exit 2
fi
case "$1" in
  radar)
    export PYTHONPATH="$PACKAGE_ROOT/runtime/radar/site-packages"
    exec "$PACKAGE_ROOT/python/3.10/bin/python3.10" "$PACKAGE_ROOT/radar/smoke_api.py" --base-url "http://127.0.0.1:$RADAR_PORT" --nifti "$2"
    ;;
  deepchest)
    export PYTHONPATH="$PACKAGE_ROOT/runtime/deepchest/site-packages"
    exec "$PACKAGE_ROOT/python/3.12/bin/python3.12" "$PACKAGE_ROOT/deepchest/smoke_api.py" --base-url "http://127.0.0.1:$DEEPCHEST_PORT" --nifti "$2"
    ;;
  *) echo "模型只能为 radar 或 deepchest" >&2; exit 2;;
esac
