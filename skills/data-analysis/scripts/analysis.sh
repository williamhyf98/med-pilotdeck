#!/usr/bin/env bash
# data-analysis 唯一入口（spec §10.4.1 / docs/data-analysis-skill-design.zh.md §2）
#
#   analysis.sh check [--json]                只读体检：运行时是否就绪、依赖是否齐
#   analysis.sh run --script P [--input D] --out D [--timeout S] [--mem-mb MB]
#   analysis.sh bootstrap-runtime             打包/镜像构建期专用，SKILL.md 不暴露
#
# 子命令与参数名必须与 src/security/policy/skillCommandSpecs.ts 逐字一致：
# 命令白名单只认空格分隔的 `--flag value`，不接受 `--flag=value`。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_SOURCE="$SKILL_DIR/runtime"
# wheels 优先用部署包统一的那份（离线包只用 offline/python-wheels，不重复打一份）
WHEEL_DIR="${PILOTDECK_ANALYSIS_WHEELS:-$RUNTIME_SOURCE/wheels}"
CACHE_ROOT="${PILOTDECK_ANALYSIS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pilotdeck-analysis}"
RUNTIME_CACHE="$CACHE_ROOT/runtime"
# 字体缓存与运行时同层共享：bootstrap 时预热一次，之后每次 run 都直接读缓存，
# 不再触发 matplotlib 的字体扫描子进程（冷缓存会跑 fc-list / system_profiler）。
export MPLCONFIGDIR="${MPLCONFIGDIR:-$CACHE_ROOT/mpl}"
# 随包中文字体（与 pdf 技能共用一份，不打第二份进镜像）
export PILOTDECK_ANALYSIS_FONTS="${PILOTDECK_ANALYSIS_FONTS:-$SKILL_DIR/../pdf/assets/fonts}"
STAMP_FILE="$RUNTIME_CACHE/.pilotdeck-requirements-hash"
RUNNER="$SCRIPT_DIR/run_analysis.py"

json_escape() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  printf '%s' "$text"
}

find_python() {
  command -v python3 2>/dev/null || command -v python 2>/dev/null || return 1
}

venv_python() {
  if [[ -x "$RUNTIME_CACHE/bin/python" ]]; then
    printf '%s\n' "$RUNTIME_CACHE/bin/python"
    return 0
  fi
  return 1
}

requirements_hash() {
  [[ -f "$RUNTIME_SOURCE/requirements.txt" ]] || { printf 'missing\n'; return 0; }
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$RUNTIME_SOURCE/requirements.txt" | awk '{print $1}'
  else
    shasum -a 256 "$RUNTIME_SOURCE/requirements.txt" | awk '{print $1}'
  fi
}

runtime_ready() {
  local python_path
  python_path="$(venv_python)" || return 1
  [[ -x "$python_path" ]] || return 1
  [[ -f "$STAMP_FILE" ]] || return 1
  [[ "$(cat "$STAMP_FILE")" == "$(requirements_hash)" ]] || return 1
  return 0
}

cmd_check() {
  local want_json=false
  [[ "${1:-}" == "--json" ]] && want_json=true

  local system_python="" runtime_python="" status="not_bootstrapped" usable=false
  system_python="$(find_python || true)"
  runtime_python="$(venv_python || true)"
  if runtime_ready; then
    status="ready"
    usable=true
  elif [[ -n "$runtime_python" ]]; then
    status="missing_dependencies"
  fi

  local packages=0
  if [[ -f "$RUNTIME_SOURCE/requirements.txt" ]]; then
    packages="$(grep -cve '^\s*#' -e '^\s*$' "$RUNTIME_SOURCE/requirements.txt" || true)"
  fi

  if [[ "$want_json" == true ]]; then
    printf '{"status":"%s","usable":%s,"python":"%s","runtime_python":"%s","runtime":"%s","packages":%s,"requirements_hash":"%s"}\n' \
      "$status" "$usable" "$(json_escape "$system_python")" "$(json_escape "$runtime_python")" \
      "$(json_escape "$RUNTIME_CACHE")" "$packages" "$(requirements_hash)"
  else
    printf 'status=%s usable=%s python=%s runtime=%s packages=%s\n' \
      "$status" "$usable" "${system_python:-none}" "$RUNTIME_CACHE" "$packages"
  fi
  # 体检本身不该失败：状态是**数据**，不是错误。调用方（agent / 管理页）看 status 字段。
  # 需要"不就绪就报错"的场合（bootstrap），在自己的入口里判断 runtime_ready。
  return 0
}

cmd_bootstrap_runtime() {
  local system_python=""
  system_python="$(find_python)" || {
    printf '{"status":"error","error":"Python 3 was not found"}\n' >&2
    exit 2
  }
  [[ -f "$RUNTIME_SOURCE/requirements.txt" ]] || {
    printf '{"status":"error","error":"runtime/requirements.txt is missing"}\n' >&2
    exit 2
  }

  mkdir -p "$CACHE_ROOT"
  if [[ ! -x "$RUNTIME_CACHE/bin/python" ]]; then
    "$system_python" -m venv "$RUNTIME_CACHE"
  fi
  local venv=""
  venv="$(venv_python)"

  if [[ -d "$WHEEL_DIR" ]] && compgen -G "$WHEEL_DIR/*.whl" >/dev/null 2>&1; then
    # 离线交付：只用随包 wheels，绝不访问网络
    "$venv" -m pip install --disable-pip-version-check --no-input --no-index \
      --find-links "$WHEEL_DIR" -r "$RUNTIME_SOURCE/requirements.txt"
  else
    "$venv" -m pip install --disable-pip-version-check --no-input \
      -r "$RUNTIME_SOURCE/requirements.txt"
  fi

  # 预热字体缓存（含随包中文字体）：失败不影响运行时可用性，只是首次绘图会自己扫一遍
  mkdir -p "$MPLCONFIGDIR"
  PYTHONPATH="$SCRIPT_DIR" "$venv" -c \
    'import matplotlib; matplotlib.use("Agg"); import analysis_plot; analysis_plot.apply()' \
    >/dev/null 2>&1 || true

  requirements_hash > "$STAMP_FILE"
  cmd_check --json
  runtime_ready
}

cmd_run() {
  local python_path=""
  if [[ -n "${PILOTDECK_ANALYSIS_PYTHON:-}" ]]; then
    # 只接受可执行文件路径；写成 "python3" 或 "/usr/bin/env python3" 这类
    # 命令串会在 exec 处失败且没有任何提示，所以先挡住
    if [[ ! -x "$PILOTDECK_ANALYSIS_PYTHON" ]]; then
      printf '{"status":"error","error":"PILOTDECK_ANALYSIS_PYTHON must be an executable path: %s"}\n' \
        "$(json_escape "$PILOTDECK_ANALYSIS_PYTHON")"
      exit 2
    fi
    python_path="$PILOTDECK_ANALYSIS_PYTHON"
  elif runtime_ready; then
    python_path="$(venv_python)"
  else
    printf '{"status":"error","error":"analysis runtime is not ready; run bootstrap-runtime at image build time","detail":%s}\n' \
      "$(cmd_check --json 2>/dev/null || printf 'null')"
    exit 2
  fi
  mkdir -p "$MPLCONFIGDIR"
  exec "$python_path" -I -B "$RUNNER" "$@"
}

case "${1:-}" in
  check)
    shift
    cmd_check "$@"
    ;;
  run)
    shift
    cmd_run "$@"
    ;;
  bootstrap-runtime)
    shift
    cmd_bootstrap_runtime "$@"
    ;;
  *)
    printf 'usage: analysis.sh {check [--json]|run --script P --out D [--input D]|bootstrap-runtime}\n' >&2
    exit 64
    ;;
esac
