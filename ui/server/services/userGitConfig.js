// ui/server/services/userGitConfig.js
//
// A user's git identity is theirs alone. Before multi-user it was applied with
// `git config --global`, which wrote the *server account's* identity — so the
// last person to save it signed everyone else's commits. It now lives in the
// `users` row plus `<userHome>/.gitconfig`, which both the user's gateway child
// process (services/gatewayPool.js) and the UI server's own `git` invocations
// (routes/git.js) read through `GIT_CONFIG_GLOBAL`.
//
// The operator's global gitconfig is never read and never `[include]`d: the
// person who runs the server must not become the fallback author of someone
// else's commits. A user who has not set an identity gets git's honest
// "Author identity unknown" error instead.
import fs from 'node:fs';
import path from 'node:path';
import { userDb } from '../database/db.js';
import { resolveUserHome } from '../utils/pilotPaths.js';

export const GIT_NAME_MAX = 128;
// `.gitconfig` is an INI-like format: only a line break can start a new section
// (e.g. `\n[core]\n sshCommand = …`) in a file the user's own gateway then
// reads, so line breaks are the only characters that must be rejected. `[`,
// `]`, `#` and `;` are ordinary characters inside the quoted value we write —
// and real names contain them (`Zhang (张) #2`), so refusing them was wrong.
export const GIT_NAME_FORBIDDEN = /[\r\n]/;

export function isValidGitName(value) {
  return typeof value === 'string'
    && value.length <= GIT_NAME_MAX
    && !GIT_NAME_FORBIDDEN.test(value);
}

/** git's own quoting: a double-quoted value with `\` and `"` backslash-escaped. */
export function quoteGitValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderGitConfig(gitName, gitEmail) {
  return `[user]\n\tname = ${quoteGitValue(gitName)}\n\temail = ${quoteGitValue(gitEmail)}\n`;
}

/** `<userHome>/.gitconfig`. Pure path math; the file need not exist. */
export function userGitConfigPath(userId, env = process.env) {
  return path.join(resolveUserHome(userId, env), '.gitconfig');
}

export function writeUserGitConfigFile(userId, gitName, gitEmail, env = process.env) {
  const file = userGitConfigPath(userId, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderGitConfig(gitName, gitEmail), { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * Backfill for identities saved before the per-user `.gitconfig` existed: when
 * the file is missing but the `users` row carries both halves of the identity,
 * write it. Returns the path either way; a missing file is a valid state.
 */
export function ensureUserGitConfigFile(userId, env = process.env) {
  const file = userGitConfigPath(userId, env);
  if (fs.existsSync(file)) return file;
  const row = userDb.getGitConfig(userId);
  if (!row?.git_name || !row?.git_email) return file;
  // Rows saved before validation existed may hold anything; a line break would
  // make git reject the whole file ("bad config line") for every command.
  if (!isValidGitName(row.git_name) || GIT_NAME_FORBIDDEN.test(row.git_email)) {
    console.warn(`[git] user ${userId}: stored git identity is not writable to .gitconfig; ask the user to save it again`);
    return file;
  }
  try {
    return writeUserGitConfigFile(userId, row.git_name, row.git_email, env);
  } catch (error) {
    console.error('Error writing per-user .gitconfig:', error);
    return file;
  }
}
