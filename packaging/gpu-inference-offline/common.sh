#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ ! -f "$PACKAGE_ROOT/config.env" ]]; then
  echo "请先运行 cp config.env.example config.env 并检查设置" >&2
  exit 2
fi
# 配置文件只能包含可信任的 shell 赋值；不要从不可信来源复制配置。
set -a
# shellcheck source=/dev/null
source "$PACKAGE_ROOT/config.env"
set +a
: "${RADAR_BIND:?}" "${RADAR_PORT:?}" "${RADAR_GPU:?}"
: "${DEEPCHEST_BIND:?}" "${DEEPCHEST_PORT:?}" "${DEEPCHEST_GPU:?}" "${DEEPCHEST_TIMEOUT:?}"
export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1
export TOKENIZERS_PARALLELISM=false
export HF_HOME="$PACKAGE_ROOT/private/cache/huggingface"
export XDG_CACHE_HOME="$PACKAGE_ROOT/private/cache/xdg"
export TORCH_HOME="$PACKAGE_ROOT/private/cache/torch"
export MPLCONFIGDIR="$PACKAGE_ROOT/private/cache/matplotlib"
export TMPDIR="$PACKAGE_ROOT/private/tmp"
# 隔离宿主机用户环境，避免已有模块/虚拟环境意外覆盖包内依赖。
unset PYTHONPATH PYTHONHOME VIRTUAL_ENV CONDA_PREFIX
mkdir -p "$PACKAGE_ROOT/private"/{logs,work,tmp,cache/huggingface,cache/xdg,cache/torch,cache/matplotlib}
chmod 700 "$PACKAGE_ROOT/private" "$PACKAGE_ROOT/private"/{logs,work,tmp,cache}
