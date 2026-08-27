#!/usr/bin/env node
/**
 * Bootstrap / patch $PILOT_HOME/pilotdeck.yaml.
 *
 * Behaviour:
 *   1. Every run: if pilotdeck.yaml exists but is missing known sections
 *      (e.g. adapters), append the default snippet so new features are
 *      discoverable without requiring users to recreate the config.
 *   2. If $PILOT_HOME/pilotdeck.yaml does not exist, do NOT write a
 *      placeholder. LLM onboarding has been removed — ship a real yaml
 *      (or copy one) before start-local. Missing config fails LLM_CHECK.
 *
 * Override the target via $PILOT_HOME (same env var the engine reads).
 * Skip the whole step via $PILOTDECK_SKIP_BOOTSTRAP=1.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    # connectionMode: stream
    # domainName: feishu
  # wecom:
  #   enabled: false
  #   token: ""
  #   extra:
  #     secret: ""
  #     websocket_url: "wss://openws.work.weixin.qq.com"
  #     dm_policy: "open"
  #     group_policy: "disabled"
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

function main() {
  if (process.env.PILOTDECK_SKIP_BOOTSTRAP === '1') {
    return;
  }

  const pilotHome = resolvePilotHome();
  const configPath = join(pilotHome, 'pilotdeck.yaml');
  if (existsSync(configPath)) {
    patchMissingSections(configPath);
    return;
  }

  console.warn(`[pilotdeck] No config at ${configPath}.`);
  console.warn(
    '[pilotdeck] Provide a real pilotdeck.yaml with model providers before start-local (LLM onboarding UI was removed).',
  );
  console.warn('[pilotdeck] start-local will fail LLM_CHECK until the file exists.');
}

main();
