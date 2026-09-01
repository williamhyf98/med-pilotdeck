#!/usr/bin/env node
/**
 * Bootstrap / patch $PILOT_HOME/pilotdeck.yaml.
 *
 * Behaviour:
 *   1. Ensure $PILOT_HOME exists (and common subdirs).
 *   2. If pilotdeck.yaml is missing, write a default template so colleagues
 *      only need to edit model url / apiKey / model id before start-local.
 *   3. If the file already exists but is missing known sections (adapters,
 *      cron, …), append the default snippets.
 *
 * Override the target via $PILOT_HOME (same env var the engine reads).
 * Skip the whole step via $PILOTDECK_SKIP_BOOTSTRAP=1.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Must stay in sync with scripts/check-llm-config.mjs */
const PLACEHOLDER_API_KEY = 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE';

function resolvePilotHome() {
  if (process.env.PILOT_HOME) return process.env.PILOT_HOME;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return join(repoRoot, '.pilotdeck-home');
}

const DEFAULT_ADAPTERS_SNIPPET = `
adapters:
  feishu:
    enabled: false
    appId: ""
    appSecret: ""
`;

const DEFAULT_CRON_SNIPPET = `
cron:
  enabled: true
  timezone: Asia/Shanghai
  maxConcurrentRuns: 2
  runTimeoutMinutes: 60
`;

const DEFAULT_TELEMETRY_SNIPPET = `
telemetry:
  enabled: false
`;

const DEFAULT_TOOLS_SNIPPET = `
tools:
  webSearch:
    enabled: false
`;

const PATCH_SECTIONS = [
  { key: 'adapters', snippet: DEFAULT_ADAPTERS_SNIPPET },
  { key: 'cron', snippet: DEFAULT_CRON_SNIPPET },
  { key: 'telemetry', snippet: DEFAULT_TELEMETRY_SNIPPET },
  { key: 'tools', snippet: DEFAULT_TOOLS_SNIPPET },
];

/**
 * Default first-run config. Field names follow the working local schema.
 * Replace url / apiKey / model ids before chatting.
 */
function buildDefaultConfigYaml() {
  return `# PilotDeck local config (auto-generated).
# Edit the model block below, then re-run: ./scripts/start-local.sh
# Required edits:
#   1. model.providers.custom.url      — OpenAI-compatible base URL (…/v1)
#   2. model.providers.custom.apiKey   — real key, or EMPTY if the server ignores auth
#   3. model.providers.custom.models   — rename "your-model-id" to your real model id
#   4. agent.model + router.scenarios.default — must match providerId/modelId
schemaVersion: 1
agent:
  model: custom/your-model-id
  params: {}
  subagents:
    default: inherit
    params: {}
model:
  providers:
    custom:
      protocol: openai
      url: http://127.0.0.1:8000/v1
      apiKey: ${PLACEHOLDER_API_KEY}
      models:
        your-model-id:
          displayName: Your Model (edit me)
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: true
            supportsJsonSchema: true
            supportsSystemPrompt: true
            maxContextTokens: 131072
            maxOutputTokens: 16384
          multimodal:
            input:
              - text
              - image
            maxImagesPerRequest: 8
            supportedImageMimeTypes:
              - image/jpeg
              - image/png
              - image/gif
              - image/webp
memory:
  enabled: true
  reasoningMode: answer_first
  autoIndexIntervalMinutes: 30
  autoDreamIntervalMinutes: 60
  captureStrategy: last_turn
  includeAssistant: true
  maxMessageChars: 6000
  heartbeatBatchSize: 30
  provider: edgeclaw
telemetry:
  enabled: false
embedding:
  enabled: false
router:
  scenarios:
    default: custom/your-model-id
  fallback:
    default:
      - custom/your-model-id
  zeroUsageRetry:
    enabled: false
    maxAttempts: 2
  tokenSaver:
    enabled: false
    judge: custom/your-model-id
    defaultTier: medium
    judgeTimeoutMs: 15000
    tiers:
      simple:
        model: custom/your-model-id
        description: Simple greetings, confirmations, single-step Q&A
      medium:
        model: custom/your-model-id
        description: Single tool call, short text generation, 1-2 file read/write
      complex:
        model: custom/your-model-id
        description: Needs sub-agent orchestration or parallel delegation
      reasoning:
        model: custom/your-model-id
        description: Deep single-agent multi-step work
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
    enabled: false
adapters:
  feishu:
    enabled: false
    appId: ""
    appSecret: ""
cron:
  enabled: true
  timezone: Asia/Shanghai
  maxConcurrentRuns: 2
  runTimeoutMinutes: 60
tools:
  webSearch:
    enabled: false
`;
}

function ensurePilotHomeLayout(pilotHome) {
  const dirs = [
    pilotHome,
    join(pilotHome, 'plugins'),
    join(pilotHome, 'skills'),
    join(pilotHome, 'projects'),
    join(pilotHome, 'memory'),
    join(pilotHome, 'cron'),
    join(pilotHome, 'logs'),
    join(pilotHome, 'workspaces', 'general', 'inbox'),
    join(pilotHome, 'workspaces', 'general', 'exports'),
    join(pilotHome, 'workspaces', 'general', 'scratch', 'qa'),
    join(pilotHome, 'workspaces', 'general', 'scratch', 'work'),
    join(pilotHome, 'workspaces', 'general', 'scratch', 'preview'),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

function patchMissingSections(configPath) {
  let content;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return;
  }

  for (const { key, snippet } of PATCH_SECTIONS) {
    const pattern = new RegExp(`^${key}\\s*:`, 'm');
    if (!pattern.test(content)) {
      try {
        appendFileSync(configPath, snippet, 'utf8');
        console.log(`[pilotdeck] Appended missing "${key}" section to ${configPath}.`);
      } catch (error) {
        console.warn(
          `[pilotdeck] Could not append "${key}" to ${configPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function writeDefaultConfig(configPath) {
  writeFileSync(configPath, buildDefaultConfigYaml(), 'utf8');
  console.log(`[pilotdeck] Created default config at ${configPath}`);
  console.log(
    '[pilotdeck] Edit model.providers (url / apiKey / models) and agent.model, then re-run start-local.',
  );
}

function main() {
  if (process.env.PILOTDECK_SKIP_BOOTSTRAP === '1') {
    return;
  }

  const pilotHome = resolvePilotHome();
  ensurePilotHomeLayout(pilotHome);

  const configPath = join(pilotHome, 'pilotdeck.yaml');
  if (existsSync(configPath)) {
    patchMissingSections(configPath);
    return;
  }

  writeDefaultConfig(configPath);
}

main();
