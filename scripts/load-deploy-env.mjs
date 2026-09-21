/**
 * Single on-site configuration entry point: `config/deploy.env`.
 *
 * The repo ships no model IP any more — `plugins/med-tools/plugin.json` now
 * carries `${env:NAME:-http://127.0.0.1:…}` placeholders, so a deployment site
 * only edits `config/deploy.env` (copied from `config/deploy.env.example`) and
 * everything downstream picks the values up.
 *
 * Rules:
 * - The shell environment always wins; the file only fills in what is unset or
 *   empty. That keeps `MED_VLM_API_BASE=… npm run dev` working for one-off runs.
 * - A missing file is not an error (dev boxes that rely on defaults), but the
 *   caller is told so it can print a loud hint instead of failing silently at
 *   the first model call.
 * - `PILOTDECK_DEPLOY_ENV` overrides the file location.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

export const DEPLOY_ENV_PATH =
  process.env.PILOTDECK_DEPLOY_ENV || join(repoRoot, 'config', 'deploy.env');
export const DEPLOY_ENV_EXAMPLE_PATH = join(repoRoot, 'config', 'deploy.env.example');

/** Env keys whose value is a model/service URL; their host bypasses the HTTP proxy. */
const URL_KEY_PATTERN = /(_API_BASE|_API_URL|_BASE_URL|_ENDPOINT)$/;

/** Known URL-valued keys to consider even when they come from the shell, not the file. */
const KNOWN_URL_KEYS = [
  'MED_VLM_API_BASE',
  'MED_EMBEDDING_API_BASE',
  'MED_EMBEDDING_ENDPOINT',
  'MED_RAG_SERVICE_API_BASE',
  'MED_RADAR_API_BASE',
  'PILOTDECK_API_URL',
  'PILOTDECK_API_BASE_URL',
  'PILOTDECK_LIGHT_API_URL',
];

/** Parse `KEY=value` lines; supports `export KEY=value`, `#` comments and quoted values. */
export function parseDeployEnv(raw) {
  const entries = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

/**
 * Read `config/deploy.env` into `process.env` without clobbering the shell.
 * @returns {{ path: string, exists: boolean, applied: string[], entries: Map<string,string> }}
 */
export function loadDeployEnv() {
  const path = DEPLOY_ENV_PATH;
  if (!existsSync(path)) {
    return { path, exists: false, applied: [], entries: new Map() };
  }
  let entries;
  try {
    entries = parseDeployEnv(readFileSync(path, 'utf8'));
  } catch (error) {
    console.warn(`warn: cannot read ${path}: ${error?.message ?? error}`);
    return { path, exists: false, applied: [], entries: new Map() };
  }
  const applied = [];
  for (const [key, value] of entries) {
    const current = process.env[key];
    if (current === undefined || current === '') {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return { path, exists: true, applied, entries };
}

/**
 * Hostnames of every configured model/service URL, so `NO_PROXY` can be derived
 * from the site config instead of a hardcoded IP.
 */
export function collectModelHosts(entries = new Map()) {
  const candidates = new Set([...entries.keys(), ...KNOWN_URL_KEYS]);
  const hosts = new Set();
  for (const key of candidates) {
    if (!KNOWN_URL_KEYS.includes(key) && !URL_KEY_PATTERN.test(key)) continue;
    const value = process.env[key] ?? entries.get(key);
    if (!value) continue;
    try {
      const { hostname } = new URL(value);
      if (hostname) hosts.add(hostname);
    } catch {
      // Not a URL (model name, token, …) — ignore.
    }
  }
  return [...hosts];
}
