#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/offline-runtime.sh"

prepare_environment
errors=0

fail() {
  echo "ERROR: $*" >&2
  errors=$((errors + 1))
}

[[ "$(uname -s)" == "Linux" ]] || fail "this package targets Linux"
[[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]] || fail "expected Linux ARM64, got $(uname -m)"
[[ -x "$RUNTIME_NODE_DIR/bin/node" ]] || fail "bundled Node is missing"
[[ -x "$RUNTIME_PYTHON_DIR/bin/python3" || -x "$RUNTIME_PYTHON_DIR/bin/python" ]] || fail "bundled Python is missing"
[[ -f "$PILOTDECK_ROOT/dist/src/cli/pilotdeck.js" ]] || fail "backend build is missing"
[[ -f "$PILOTDECK_ROOT/ui/dist/index.html" ]] || fail "frontend build is missing"
[[ -f "$PILOT_HOME/pilotdeck.yaml" ]] || fail "PilotDeck config is missing"
[[ -f "$DEPLOY_ENV_FILE" ]] || fail "deployment config is missing: $DEPLOY_ENV_FILE"
[[ -d "$PYTHON_WHEELS_DIR" ]] || fail "offline Python wheels are missing"
[[ -f "$PILOTDECK_ROOT/plugins/med-tools/plugin.json" ]] || fail "med-tools plugin is missing"

if [[ -x "$RUNTIME_NODE_DIR/bin/node" ]]; then
  "$RUNTIME_NODE_DIR/bin/node" -e '
    const { createRequire } = require("node:module");
    const root = createRequire(process.cwd() + "/package.json");
    const ui = createRequire(process.cwd() + "/ui/package.json");
    for (const [label, req, names] of [
      ["root", root, ["sharp", "tsx"]],
      ["ui", ui, ["better-sqlite3", "node-pty"]],
    ]) for (const name of names) {
      try { req.resolve(name); }
      catch (error) { console.error(`${label} dependency missing: ${name}: ${error.message}`); process.exitCode = 1; }
    }
  ' || fail "one or more Node dependencies are unavailable"
fi

if [[ -x "$RUNTIME_PYTHON_DIR/bin/python3" || -x "$RUNTIME_PYTHON_DIR/bin/python" ]]; then
  python_bin="$(runtime_python)"
  "$python_bin" - <<'PY' || fail "bundled Python cannot import pip"
import pip
print("bundled python:", __import__("sys").version.split()[0])
PY
fi

if (( errors > 0 )); then
  echo "offline package check failed with ${errors} error(s)." >&2
  exit 1
fi

echo "offline package check passed"
echo "  root:   $PILOTDECK_ROOT"
echo "  home:   $PILOT_HOME"
echo "  node:   $("$RUNTIME_NODE_DIR/bin/node" --version)"
echo "  python: $($(runtime_python) -V 2>&1)"
echo "  server: $SERVER_PORT"
echo "  gateway:$PILOTDECK_GATEWAY_PORT"
