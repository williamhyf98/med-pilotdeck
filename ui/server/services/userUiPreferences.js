import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveUserHome } from '../utils/pilotPaths.js';

const NAME = 'ui-preferences.json';
const MAX_BYTES = 16 * 1024;
const THEMES = new Set(['light', 'dark', 'warm', 'command']);
const LANGUAGES = new Set(['zh-CN', 'en']);
const SORT_ORDERS = new Set(['name', 'date']);
const FONT_SIZES = new Set(['10', '11', '12', '13', '14', '15', '16', '18', '20']);
const BOOLEAN_KEYS = new Set([
  'showProcessTrace', 'autoExpandTools', 'showRawParameters', 'showThinking',
  'inlineThinking', 'autoScrollToBottom', 'sendByCtrlEnter', 'sidebarVisible',
  'codeEditorWordWrap', 'codeEditorShowMinimap', 'codeEditorLineNumbers',
]);
const KEYS = new Set([
  ...BOOLEAN_KEYS, 'themeMode', 'userLanguage', 'projectSortOrder', 'codeEditorFontSize',
]);
const writes = new Map();

export class InvalidUiPreferences extends Error {}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidUiPreferences('Expected a preferences object');
  }
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KEYS.has(key)) throw new InvalidUiPreferences('Unknown preference');
    if (BOOLEAN_KEYS.has(key) ? typeof value !== 'boolean'
      : key === 'themeMode' ? !THEMES.has(value)
        : key === 'userLanguage' ? !LANGUAGES.has(value)
          : key === 'projectSortOrder' ? !SORT_ORDERS.has(value)
            : !FONT_SIZES.has(value)) {
      throw new InvalidUiPreferences('Invalid preference value');
    }
    result[key] = value;
  }
  return result;
}

async function location(userId) {
  const home = resolveUserHome(userId);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(home)).isSymbolicLink()) {
    throw new Error('Invalid user home');
  }
  return path.join(home, NAME);
}

async function readAt(file) {
  const stat = await fs.lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid preferences file');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!data || data.version !== 1 || !data.preferences) throw new Error('Invalid preferences file');
  return normalize(data.preferences);
}

export async function readUserUiPreferences(userId) {
  return readAt(await location(userId));
}

export async function updateUserUiPreferences(userId, patch) {
  const changes = normalize(patch);
  const key = String(userId);
  const prior = writes.get(key) || Promise.resolve();
  const current = prior.catch(() => {}).then(async () => {
    const file = await location(userId);
    const preferences = { ...(await readAt(file)), ...changes };
    const content = JSON.stringify({ version: 1, preferences });
    if (Buffer.byteLength(content) > MAX_BYTES) throw new InvalidUiPreferences('Preferences too large');
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return preferences;
  });
  writes.set(key, current);
  try {
    return await current;
  } finally {
    if (writes.get(key) === current) writes.delete(key);
  }
}
