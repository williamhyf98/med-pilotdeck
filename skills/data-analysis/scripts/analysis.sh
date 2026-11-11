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
WHEEL_DIR="$RUNTIME_SOURCE/wheels"
CACHE_ROOT="${PILOTDECK_ANALYSIS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pilotdeck-analysis}"
RUNTIME_CACHE="$CACHE_ROOT/runtime"
# 字体缓存与运行时同层共享：bootstrap 时预热一次，之后每次 run 都直接读缓存，
# 不再触发 matplotlib 的字体扫描子进程（冷缓存会跑 fc-list / system_profiler）。
export MPLCONFIGDIR="${MPLCONFIGDIR:-$CACHE_ROOT/mpl}"
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
  [[ "$status" == "ready" ]]
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

  if compgen -G "$WHEEL_DIR/*.whl" >/dev/null 2>&1; then
    # 离线交付：只用随包 wheels，绝不访问网络
    "$venv" -m pip install --disable-pip-version-check --no-input --no-index \
      --find-links "$WHEEL_DIR" -r "$RUNTIME_SOURCE/requirements.txt"
  else
    "$venv" -m pip install --disable-pip-version-check --no-input \
      -r "$RUNTIME_SOURCE/requirements.txt"
  fi

  # 预热字体缓存：失败不影响运行时可用性，只是首次绘图会自己扫一遍
  mkdir -p "$MPLCONFIGDIR"
  "$venv" -c 'import matplotlib; matplotlib.use("Agg"); from matplotlib import font_manager; font_manager.fontManager' \
    >/dev/null 2>&1 || true

  requirements_hash > "$STAMP_FILE"
  cmd_check --json
}

cmd_run() {
  local python_path=""
  if [[ -n "${PILOTDECK_ANALYSIS_PYTHON:-}" ]]; then
    python_path="$PILOTDECK_ANALYSIS_PYTHON"
  elif runtime_ready; then
    python_path="$(venv_python)"
  else
    printf '{"status":"error","error":"analysis runtime is not ready; run bootstrap-runtime at image build time","status_detail":"%s"}\n' "$(cmd_check --json >/dev/null 2>&1 || printf 'not_bootstrapped')"
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
