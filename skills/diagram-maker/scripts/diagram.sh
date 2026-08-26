#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

find_python() {
  command -v python3 2>/dev/null || command -v python 2>/dev/null || return 1
}

cmd_check() {
  local python_path=""
  if python_path="$(find_python)"; then
    printf '{"status":"ok","python":true,"python_path":"%s","dependencies":"stdlib-only"}\n' "$python_path"
    return 0
  fi
  printf '{"status":"missing_dependencies","python":false,"error":"交付包不完整：图示本地运行时未就绪。"}\n'
  return 1
}

case "${1:-}" in
  check)
    shift
    cmd_check "$@"
    ;;
  bootstrap-runtime)
    shift
    cmd_check "$@"
    ;;
  fix)
    printf '{"status":"error","code":"offline-install-disabled","error":"diagram.sh 不支持现场安装。请使用完整交付包，不要安装浏览器、Graphviz 或 Mermaid CLI。"}\n' >&2
    exit 2
    ;;
  ""|-h|--help|help)
    printf 'Usage: diagram.sh <check|make|self-test> [options]\n'
    ;;
  *)
    python_path="$(find_python || true)"
    if [[ -z "$python_path" ]]; then
      printf '{"status":"error","code":"missing-dependencies","error":"交付包不完整：图示本地运行时未就绪。"}\n' >&2
      exit 2
    fi
    export DIAGRAM_SKILL_ROOT="$SKILL_DIR"
    exec "$python_path" "$SCRIPT_DIR/diagram_cli.py" "$@"
    ;;
esac
