#!/usr/bin/env bash
# Download Node + portable CPython into PilotDeck/.runtime and install project deps.
# After this succeeds, scripts/start-local.sh can run without ultrafast_share.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib-local-runtime.sh"

NODE_VERSION="${PILOTDECK_NODE_VERSION:-$NODE_VERSION_DEFAULT}"
PY_TAG="${PILOTDECK_PY_STANDALONE_TAG:-$PY_STANDALONE_TAG_DEFAULT}"
PY_VERSION="${PILOTDECK_PY_VERSION:-$PY_STANDALONE_VERSION_DEFAULT}"

FORCE="${PILOTDECK_BOOTSTRAP_FORCE:-0}"

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) NODE_ARCH="x64"; PY_TRIPLE="x86_64-unknown-linux-gnu" ;;
  aarch64|arm64) NODE_ARCH="arm64"; PY_TRIPLE="aarch64-unknown-linux-gnu" ;;
  *)
    echo "error: unsupported arch: ${arch}" >&2
    exit 1
    ;;
esac

apply_local_runtime_env

echo "==> PilotDeck local runtime bootstrap"
echo "    root:    ${PILOTDECK_ROOT}"
echo "    runtime: ${RUNTIME_DIR}"
echo "    tmp:     ${TMPDIR}"

install_node() {
  local node_bin="${RUNTIME_NODE_DIR}/bin/node"
  if [[ "$FORCE" != "1" && -x "$node_bin" ]]; then
    local have
    have="$("$node_bin" -v 2>/dev/null || true)"
    if [[ "$have" == "v${NODE_VERSION}" ]]; then
      echo "==> Node ${have} already present"
      return 0
    fi
  fi

  # Prefer a local copy (home install) to avoid re-download when versions match.
  local local_copy="${HOME}/.local/node-v${NODE_VERSION}"
  if [[ "$FORCE" != "1" && -x "${local_copy}/bin/node" ]]; then
    echo "==> Copying Node v${NODE_VERSION} from ${local_copy}"
    rm -rf "$RUNTIME_NODE_DIR"
    mkdir -p "$RUNTIME_DIR"
    cp -a "$local_copy" "$RUNTIME_NODE_DIR"
    return 0
  fi

  local tarball="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  local dest="${RUNTIME_DOWNLOADS_DIR}/${tarball}"
  local url_primary="https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${tarball}"
  local url_fallback="https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"

  echo "==> Downloading Node v${NODE_VERSION}"
  if ! download_file "$url_primary" "$dest"; then
    echo "    mirror failed, trying nodejs.org..."
    download_file "$url_fallback" "$dest"
  fi

  echo "==> Extracting Node"
  rm -rf "$RUNTIME_NODE_DIR"
  mkdir -p "$RUNTIME_DIR"
  tar -xJf "$dest" -C "$RUNTIME_DIR"
  mv "${RUNTIME_DIR}/node-v${NODE_VERSION}-linux-${NODE_ARCH}" "$RUNTIME_NODE_DIR"
  echo "    node: $("$node_bin" -v)"
}

install_python() {
  local py_bin
  py_bin="$(runtime_python)"
  if [[ "$FORCE" != "1" && -x "$py_bin" ]]; then
    echo "==> Portable Python already present: $("$py_bin" -V 2>&1)"
    return 0
  fi

  local tarball="cpython-${PY_VERSION}+${PY_TAG}-${PY_TRIPLE}-install_only_stripped.tar.gz"
  local dest="${RUNTIME_DOWNLOADS_DIR}/${tarball}"
  local url="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/${tarball}"

  echo "==> Downloading portable CPython ${PY_VERSION} (${PY_TAG})"
  download_file "$url" "$dest"

  echo "==> Extracting Python"
  rm -rf "$RUNTIME_PYTHON_DIR"
  mkdir -p "$RUNTIME_DIR"
  # Archive contains a top-level "python/" directory.
  tar -xzf "$dest" -C "$RUNTIME_DIR"
  if [[ ! -x "$(runtime_python)" ]]; then
    echo "error: python binary missing after extract under ${RUNTIME_PYTHON_DIR}" >&2
    exit 1
  fi
  echo "    python: $($(runtime_python) -V 2>&1)"
}

ensure_pnpm() {
  local node_bin
  node_bin="$(runtime_node)"
  export PATH="$(dirname "$node_bin"):${PATH}"

  if [[ -x "${RUNTIME_NODE_DIR}/bin/pnpm" ]]; then
    echo "==> pnpm already available: $(pnpm -v)"
    return 0
  fi

  echo "==> Enabling pnpm via corepack"
  if "$node_bin" -e "require('module').builtinModules.includes('module')" >/dev/null 2>&1; then
    if command -v corepack >/dev/null 2>&1; then
      corepack enable || true
      corepack prepare "pnpm@10.32.1" --activate
    fi
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "==> Installing pnpm via npm (project-local prefix)"
    mkdir -p "${RUNTIME_DIR}/npm-global"
    npm install -g "pnpm@10.32.1" --prefix "${RUNTIME_DIR}/npm-global"
    export PATH="${RUNTIME_DIR}/npm-global/bin:${PATH}"
  fi
  echo "    pnpm: $(pnpm -v)"
}

install_js_deps() {
  cd "$PILOTDECK_ROOT"
  echo "==> Installing JS dependencies (pnpm) into project node_modules"
  # Prefer frozen lockfile when present; fall back if needed.
  if [[ -f pnpm-lock.yaml ]]; then
    CI=true pnpm install --store-dir "$RUNTIME_PNPM_STORE" || CI=true pnpm install --store-dir "$RUNTIME_PNPM_STORE" --no-frozen-lockfile
  else
    CI=true npm install
  fi
}

install_med_tools_venv() {
  local py_bin med_dir
  py_bin="$(runtime_python)"
  med_dir="${PILOTDECK_ROOT}/plugins/med-tools"
  if [[ ! -f "${med_dir}/requirements.txt" ]]; then
    echo "==> med-tools not present; skipping Python venv"
    return 0
  fi

  echo "==> Creating med-tools venv with project Python"
  # Rebuild if linked to something outside the project runtime.
  if [[ -d "${med_dir}/.venv" ]]; then
    local cfg_home=""
    if [[ -f "${med_dir}/.venv/pyvenv.cfg" ]]; then
      cfg_home="$(awk -F' *= *' '/^home *=/{print $2; exit}' "${med_dir}/.venv/pyvenv.cfg" || true)"
    fi
    if [[ "$FORCE" == "1" ]] || [[ "$cfg_home" != "${RUNTIME_PYTHON_DIR}/bin"* && "$cfg_home" != "${RUNTIME_PYTHON_DIR}"* ]]; then
      echo "    replacing existing .venv (was home=${cfg_home:-unknown})"
      rm -rf "${med_dir}/.venv"
    fi
  fi

  PYTHON_BIN="$py_bin" bash "${med_dir}/setup.sh"
}

# Warm the bundled document skill runtimes. The skills locate their venv through
# XDG_CACHE_HOME, which apply_local_runtime_env pins inside .runtime/cache, so a
# runtime installed by hand in a plain shell lands somewhere the gateway cannot
# see and every document request reports an incomplete delivery package.
SKILL_RUNTIME_SUMMARY=""

install_skill_runtimes() {
  local skill entrypoint script
  for skill in pdf docx pptx spreadsheets; do
    entrypoint="$skill"
    [[ "$skill" == "spreadsheets" ]] && entrypoint="spreadsheet"
    script="${PILOTDECK_ROOT}/skills/${skill}/scripts/${entrypoint}.sh"
    if [[ ! -f "$script" ]]; then
      echo "==> skills/${skill} not present; skipping its runtime"
      continue
    fi
    echo "==> Warming ${skill} skill runtime"
    if bash "$script" bootstrap-runtime; then
      SKILL_RUNTIME_SUMMARY+="    skill runtime ${skill}: ok"$'\n'
    else
      SKILL_RUNTIME_SUMMARY+="    skill runtime ${skill}: FAILED (check: bash ${script} check)"$'\n'
      echo "warn: ${skill} skill runtime is not ready; document requests will report an incomplete delivery package" >&2
    fi
  done
}

install_node
install_python
# Re-apply PATH now that binaries exist.
apply_local_runtime_env
assert_no_share
ensure_pnpm
install_js_deps
install_med_tools_venv
install_skill_runtimes

echo
echo "==> Bootstrap complete"
echo "    node:   $(command -v node) ($(node -v))"
echo "    python: $(runtime_python) ($($(runtime_python) -V 2>&1))"
printf '%s' "$SKILL_RUNTIME_SUMMARY"
echo "    start:  ${PILOTDECK_ROOT}/scripts/start-local.sh"
du -sh "$RUNTIME_DIR" "${PILOTDECK_ROOT}/node_modules" "${PILOTDECK_ROOT}/plugins/med-tools/.venv" 2>/dev/null || true
