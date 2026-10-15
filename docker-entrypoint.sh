#!/usr/bin/env bash
set -euo pipefail

PILOT_HOME="${PILOT_HOME:-/root/.pilotdeck}"
CONFIG_FILE="$PILOT_HOME/pilotdeck.yaml"

mkdir -p "$PILOT_HOME/plugins" "$PILOT_HOME/system"

if [ -d "$CONFIG_FILE" ]; then
  echo "[pilotdeck-docker] ERROR: $CONFIG_FILE is a directory, not a config file." >&2
  echo "[pilotdeck-docker] If you intended to mount a YAML config, create the host file first or remove the bind mount and use PILOTDECK_* env vars." >&2
  exit 1
fi

# ── Generate config from env vars if no config file is mounted ────────
if [ ! -f "$CONFIG_FILE" ]; then
  # Offline delivery: never default to a public endpoint. The site must point
  # PILOTDECK_API_URL at its own OpenAI-compatible server (see config/deploy.env).
  API_URL="${PILOTDECK_API_URL:-}"
  if [ -z "$API_URL" ]; then
    echo "[pilotdeck-docker] ERROR: PILOTDECK_API_URL is not set and no config is mounted at $CONFIG_FILE." >&2
    echo "[pilotdeck-docker] Set the on-site model endpoint, e.g.:" >&2
    echo "[pilotdeck-docker]   PILOTDECK_API_URL=http://<model-host>:8030/v1" >&2
    echo "[pilotdeck-docker]   PILOTDECK_MODEL=custom/G9-V-Med" >&2
    echo "[pilotdeck-docker] Compose users: put them in config/deploy.env (see config/deploy.env.example)." >&2
    exit 1
  fi
  MODEL="${PILOTDECK_MODEL:-custom/G9-V-Med}"
  LIGHT_MODEL="${PILOTDECK_LIGHT_MODEL:-${MODEL}}"
  API_KEY="${PILOTDECK_API_KEY:-EMPTY}"

  # Derive provider name from model string (e.g. "openrouter/deepseek/deepseek-v4-flash" -> "openrouter")
  PROVIDER="${MODEL%%/*}"
  LIGHT_PROVIDER="${LIGHT_MODEL%%/*}"
  # Model ID is everything after the first slash
  MODEL_ID="${MODEL#*/}"
  LIGHT_MODEL_ID="${LIGHT_MODEL#*/}"

  # Router section shared by both same-provider and cross-provider branches
  ROUTER_SECTION="router:
  scenarios:
    default: ${MODEL}
  fallback:
    default:
      - ${MODEL}
  zeroUsageRetry:
    enabled: true
    maxAttempts: 2
  tokenSaver:
    enabled: true
    judge: ${LIGHT_MODEL}
    defaultTier: medium
    judgeTimeoutMs: 15000
    tiers:
      simple:
        model: ${LIGHT_MODEL}
        description: \"Simple greetings, confirmations, single-step Q&A, trivial file writes, remembering rules\"
      medium:
        model: ${LIGHT_MODEL}
        description: \"Single tool call, short text generation, 1-2 file read/write, code generation\"
      complex:
        model: ${MODEL}
        description: \"Needs coordinated work across independent workstreams that can proceed in parallel\"
      reasoning:
        model: ${MODEL}
        description: \"Deep single-agent work: multi-file operations, data analysis, multi-step workflows, structured reports from many sources\"
    rules:
      - \"complex is ONLY for tasks that need coordinated parallel workstreams — do NOT use it for ordinary multi-step work\"
      - \"Multi-file operations, data analysis, and multi-step workflows without orchestration should be reasoning\"
      - \"Simple file creation (1-2 files) or single code generation is medium\"
      - \"Trivial greetings, confirmations, remembering rules, or reading one file and answering a short question is simple\"
  autoOrchestrate:
    enabled: false
    triggerTiers:
      - complex
    slimSystemPrompt: true
    allowedTools:
      - read_file
      - grep
      - glob
      - read_skill
  stats:
    enabled: true"

  if [ "$PROVIDER" = "$LIGHT_PROVIDER" ]; then
    # Same provider for both models
    cat > "$CONFIG_FILE" <<YAML
schemaVersion: 1
agent:
  model: ${MODEL}
model:
  providers:
    ${PROVIDER}:
      protocol: openai
      url: ${API_URL}
      apiKey: ${API_KEY}
      models:
        ${MODEL_ID}:
          capabilities:
            maxOutputTokens: 32768
        ${LIGHT_MODEL_ID}:
          capabilities:
            maxOutputTokens: 16384
cron:
  enabled: true
${ROUTER_SECTION}
YAML
  else
    # Different providers — declare both
    LIGHT_API_URL="${PILOTDECK_LIGHT_API_URL:-${API_URL}}"
    LIGHT_API_KEY="${PILOTDECK_LIGHT_API_KEY:-${API_KEY}}"
    cat > "$CONFIG_FILE" <<YAML
schemaVersion: 1
agent:
  model: ${MODEL}
model:
  providers:
    ${PROVIDER}:
      protocol: openai
      url: ${API_URL}
      apiKey: ${API_KEY}
      models:
        ${MODEL_ID}:
          capabilities:
            maxOutputTokens: 32768
    ${LIGHT_PROVIDER}:
      protocol: openai
      url: ${LIGHT_API_URL}
      apiKey: ${LIGHT_API_KEY}
      models:
        ${LIGHT_MODEL_ID}:
          capabilities:
            maxOutputTokens: 16384
cron:
  enabled: true
${ROUTER_SECTION}
YAML
  fi

  echo "[pilotdeck-docker] Generated config at $CONFIG_FILE (provider=$PROVIDER, model=$MODEL, light=$LIGHT_MODEL)"
fi

# ── Forward proxy env vars ────────────────────────────────────────────
if [ -n "${PILOTDECK_PROXY:-}" ]; then
  export http_proxy="$PILOTDECK_PROXY"
  export https_proxy="$PILOTDECK_PROXY"
  export HTTP_PROXY="$PILOTDECK_PROXY"
  export HTTPS_PROXY="$PILOTDECK_PROXY"
  echo "[pilotdeck-docker] Proxy set to $PILOTDECK_PROXY"
fi

echo "[pilotdeck-docker] Starting PilotDeck UI server..."
echo "[pilotdeck-docker] Config: $CONFIG_FILE"
echo "[pilotdeck-docker] UI will be available at http://0.0.0.0:${SERVER_PORT:-3001}"

# No standalone gateway is pre-started here: the UI server's Gateway pool spawns
# one `pilotdeck server` child per user on that user's first request
# (PILOTDECK_GATEWAY_PORT_BASE sets the first port it tries), so there is a
# single process to supervise.
cd /app

exec node --import tsx ui/server/index.js
