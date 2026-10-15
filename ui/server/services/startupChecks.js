// ui/server/services/startupChecks.js
// Boot-time sanity checks for things the launch scripts normally prepare.
// A server started by hand (plain `npm run dev:server`) skips those scripts;
// without these warnings the only symptom is that the agent's answers get
// worse because the medical tools silently went missing.
import fs from 'node:fs';
import path from 'node:path';
import { loadDeployEnv } from '../../../scripts/load-deploy-env.mjs';

/**
 * The med-tools plugin is linked into `<root>/plugins/` by the launch scripts
 * (lib-local-runtime.sh / docker-entrypoint.sh). Every user's Gateway finds
 * plugins only there, so a missing link means no medical MCP tools for anyone.
 * @returns {string | null} the warning that was logged, or null when fine
 */
export function checkMedicalPlugin({ root, repoRoot, log = console.warn }) {
  const linked = path.join(root, 'plugins', 'med-tools', 'plugin.json');
  if (fs.existsSync(linked)) return null;
  const source = path.join(repoRoot, 'plugins', 'med-tools');
  const message = fs.existsSync(source)
    ? `[startup] ${path.join(root, 'plugins', 'med-tools')} is missing: the medical MCP tools (RAG, RADAR, DeepChest…) are unavailable to every user. Start through scripts/start-local.sh, or link it: ln -sfn "${source}" "${path.join(root, 'plugins', 'med-tools')}"`
    : `[startup] no med-tools plugin under ${path.join(root, 'plugins')} and none in the repository (${source}); medical tools are unavailable.`;
  log(message);
  return message;
}

/**
 * `config/deploy.env` holds the model/service URLs (RAG, RADAR, embeddings).
 * The server loads it on import (load-env.js → register-deploy-env.mjs);
 * re-reading is idempotent (shell wins), so this only reports whether it existed.
 * @returns {string | null}
 */
export function checkDeployEnv({ log = console.warn } = {}) {
  const site = loadDeployEnv();
  if (site.exists) return null;
  const message = `[startup] ${site.path} not found: med-tools falls back to 127.0.0.1 placeholder service URLs. Copy config/deploy.env.example and fill in the site URLs (or set PILOTDECK_DEPLOY_ENV).`;
  log(message);
  return message;
}
