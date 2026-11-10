#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_python() {
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
  elif command -v python >/dev/null 2>&1; then
    command -v python
  else
    return 1
  fi
}

emit_missing_python() {
  printf '{"status":"error","code":"python-not-found","error":"HTML 静态检查需要 Python 3；请使用包含 Python 的交付包。"}\n' >&2
  exit 2
}

cmd_check() {
  local py=""
  if ! py="$(find_python)"; then
    printf '{"status":"error","code":"python-not-found","python":false,"audit":false,"package":false}\n'
    exit 2
  fi
  printf '{"status":"ok","python":true,"python_path":"%s","audit":true,"package":true}\n' "$py"
}

case "${1:-}" in
  check)
    shift
    cmd_check "$@"
    ;;
  themes)
    py="$(find_python)" || emit_missing_python
    shared="$SCRIPT_DIR/../../_shared/tokens.py"
    if [ ! -f "$shared" ]; then
      printf '{"status":"error","code":"theme-tokens-missing","error":"交付包缺少 skills/_shared/design-tokens.json。"}\n' >&2
      exit 2
    fi
    "$py" - "$shared" <<'PY'
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("pilotdeck_shared_tokens", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
listed = module.list_themes()
tokens = module.load_tokens()["tokens"]
default_id = tokens.get("defaultTheme")
themes = []
for item in listed["themes"]:
    if item.get("status") == "hidden":
        continue
    themes.append({**item, "surface": tokens["themes"][item["id"]].get("surface", {})})
print(json.dumps({"status": "ok", "default": default_id, "themes": themes,
                  "source": listed["source"]}, ensure_ascii=False))
PY
    ;;
  audit)
    shift
    py="$(find_python)" || emit_missing_python
    exec "$py" "$SCRIPT_DIR/html_audit.py" "$@"
    ;;
  package)
    shift
    py="$(find_python)" || emit_missing_python
    exec "$py" "$SCRIPT_DIR/html_package.py" "$@"
    ;;
  verify)
    shift
    py="$(find_python)" || emit_missing_python
    exec "$py" "$SCRIPT_DIR/html_package.py" --verify "$@"
    ;;
  ""|-h|--help|help)
    printf 'Usage: html.sh <check|themes|audit|package|verify> [options]\n\n'
    printf '  check                         Report whether Python-based static checks work\n'
    printf '  themes                        List the six design themes and their surface components\n'
    printf '  audit <file|dir> [--out F] [--require-text S] [--require-heading S]\n'
    printf '                                Fact-class static audit + requirement coverage (no browser)\n'
    printf '  package --html F [--out-dir D] [--update] [--no-zip] [--report R]\n'
    printf '                                Build an offline folder + deterministic .zip\n'
    printf '  verify <dir>                  Check entry page, audit and zip/disk consistency\n'
    ;;
  *)
    printf '{"status":"error","code":"unknown-command","error":"Unknown html.sh command: %s"}\n' "$1" >&2
    exit 2
    ;;
esac
