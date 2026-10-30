#!/usr/bin/env bash
# 在 node12 上运行，打出无需在线 pip 安装的候选包；不接触正在运行的服务。
set -euo pipefail
SOURCE=/local_data/huojianfan/handoff-validation-20261014
DEST="${1:-/local_data/huojianfan/gpu-inference-offline-work}"
STAGING="$DEST/gpu-inference-offline-20261029"
OUT="$DEST/gpu-inference-offline-20261029.tar.gz"
mkdir -p "$STAGING"/{python/3.10/bin,python/3.10/lib/python3.10,python/3.12,runtime/radar/site-packages,runtime/deepchest/site-packages,private}
chmod 700 "$STAGING/private"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
rsync -a "$script_dir/" "$STAGING/" --exclude build-on-node12.sh
cp "$SOURCE/VALIDATION.md" "$STAGING/SOURCE-VALIDATION.md"
rsync -a "$SOURCE/validated-handoffs/radar-gpu-handoff-keyless-validated-20261014/" "$STAGING/radar/"
rsync -a "$SOURCE/validated-handoffs/deepchest-gpu-handoff-validated-20261014/" "$STAGING/deepchest/"
rsync -a --exclude __pycache__ --exclude '*.pyc' --exclude '__editable__*' \
  "$SOURCE/radar-venv/lib/python3.10/site-packages/" "$STAGING/runtime/radar/site-packages/"
rsync -a --exclude __pycache__ --exclude '*.pyc' --exclude '__editable__*' \
  "$SOURCE/deepchest-venv/lib/python3.12/site-packages/" "$STAGING/runtime/deepchest/site-packages/"

# Python 3.10 的系统安装必须复制标准库及可执行文件：目标机不需要安装 Python。
# /usr/lib/python3.10 的 distutils 为 OS 特定包，保留标准库原始结构。
cp /usr/bin/python3.10 "$STAGING/python/3.10/bin/python3.10"
rsync -a --exclude __pycache__ --exclude '*.pyc' /usr/lib/python3.10/ "$STAGING/python/3.10/lib/python3.10/"
rm -f "$STAGING/python/3.10/lib/python3.10/sitecustomize.py"
mkdir -p "$STAGING/python/3.10/lib/x86_64-linux-gnu"
cp /usr/lib/x86_64-linux-gnu/libpython3.10.so.1.0 \
  "$STAGING/python/3.10/lib/x86_64-linux-gnu/libpython3.10.so.1"
# Python build standalone 为安装目录专用，来自 node12 现有运行时缓存。
rsync -a --exclude __pycache__ --exclude '*.pyc' \
  /local_data/huojianfan/med-pilotdeck/.runtime/python/ "$STAGING/python/3.12/"

# Python 3.10 的 sys.prefix 由可执行文件所在位置推断，不使用目标主机 Python。
# 外层包路径会变化，DeepChest 现有代码通过 .venvs/radar/bin 固定路径寻找入口。
mkdir -p "$STAGING/deepchest/.venvs/radar/bin"
cat >"$STAGING/deepchest/.venvs/radar/bin/python" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/../../.." && pwd -P)"
bundle="$(cd -- "$root/.." && pwd -P)"
export PYTHONNOUSERSITE=1
export PYTHONHOME="$bundle/python/3.12"
export PYTHONPATH="$bundle/runtime/deepchest/site-packages:$root/third_party/CT-CLIP-official/CT_CLIP:$root/third_party/CT-CLIP-official/transformer_maskgit"
exec "$bundle/python/3.12/bin/python3.12" "$@"
SH
cat >"$STAGING/deepchest/.venvs/radar/bin/TotalSegmentator" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/../../.." && pwd -P)"
exec "$root/.venvs/radar/bin/python" -m totalsegmentator.bin.TotalSegmentator "$@"
SH
chmod +x "$STAGING/deepchest/.venvs/radar/bin/"{python,TotalSegmentator}
chmod +x "$STAGING/"{start,doctor,health,smoke,verify}.sh
cp "$STAGING/config.env.example" "$STAGING/config.env"
echo "本地 config.env 可修改，无需 pip 安装" >"$STAGING/BUILD-NOTES.txt"
(
  cd "$STAGING"
  find . -type f ! -path './private/*' ! -name SHA256SUMS ! -name config.env \
    -print0 | sort -z | xargs -0 -n 32 sha256sum >SHA256SUMS
)
# 使用 GNU tar 的 pigz 并行压缩，包内保留可审阅 manifest。
tar -C "$DEST" -cf - "$(basename "$STAGING")" | pigz -1 >"$OUT.tmp"
mv "$OUT.tmp" "$OUT"
( cd "$DEST" && sha256sum "$(basename "$OUT")" >"$(basename "$OUT").sha256" )
echo "$OUT"
echo "$OUT.sha256"
