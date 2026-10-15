// ui/server/services/legacyLayout.js
// Pure filesystem inspection/planning for the legacy -> per-user migration.
// Deliberately free of any database import so `--dry-run` can plan without
// opening (and thereby creating) the system database.
import fs from 'node:fs';
import path from 'node:path';
import { createProjectId, resolveUserHome } from '../utils/pilotPaths.js';

export const LEGACY_DONE_MARKER = path.join('system', 'migration', 'legacy-done.json');
export const HISTORY_DIR = path.join('system', 'migration', 'history');

const MOVE_ENTRIES = ['projects', 'workspaces', 'memory', 'skills', 'logs', '.pilotdeck', '.tmp', '.legacy-bundled-skills-migrated-v1'];
// `archives/` is root-owned (it also holds the migration snapshots and
// `archives/users/<id>-<ts>` soft-deleted homes). Only `archives/projects/`
// is user data (spec 9.4), so it is handled as a child-level move.
const ARCHIVES_CHILD = path.join('archives', 'projects');
const DROP_ENTRIES = ['router', 'telemetry', 'cron', 'server-token'];
const ARCHIVE_ENTRIES = ['migration-backups', 'migration-reports', '.workspace-migration-v1.json'];
const KEEP_ENTRIES = ['pilotdeck.yaml', 'plugins', 'system', 'users', 'archives'];
const isKept = (name) => KEEP_ENTRIES.includes(name) || name.startsWith('pilotdeck.yaml.bak');
const isAuthDb = (name) => name === 'auth.db' || name === 'auth.db-wal' || name === 'auth.db-shm';

/** `archives/projects` only: a missing (or dangling) path is simply "not legacy". */
function isNonEmptyDirOrFalse(target) {
  try { return fs.statSync(target).isDirectory() && fs.readdirSync(target).length > 0; } catch { return false; }
}

export function detectLegacyLayout(root) {
  if (!fs.existsSync(root)) return { present: false, entries: [] };
  const entries = fs.readdirSync(root).filter((name) => !isKept(name));
  // statSync (not lstat) on purpose: a dangling symlink named like a legacy
  // directory throws here and fails the migration closed.
  const dataDirs = entries.filter((n) => MOVE_ENTRIES.includes(n)
    && fs.statSync(path.join(root, n)).isDirectory()
    && fs.readdirSync(path.join(root, n)).length > 0);
  const legacyArchives = isNonEmptyDirOrFalse(path.join(root, ARCHIVES_CHILD));
  return { present: dataDirs.length > 0 || legacyArchives || entries.some(isAuthDb), entries };
}

/**
 * Spec 9.1: the migration may only run while `<root>/users/` is empty. The
 * administrator's own home is created before detection runs, so "empty" means
 * "nothing but `users/<adminId>`". Kept here (db-free) so `--dry-run` can ask
 * the same question without opening the system database.
 */
export function hasOtherUserHomes(root, adminId) {
  const dir = path.join(root, 'users');
  let names;
  try { names = fs.readdirSync(dir); } catch { return false; }
  return names.some((name) => name !== String(adminId));
}

export function planLegacyMigration({ root, adminId, env = process.env }) {
  const home = resolveUserHome(adminId, env);
  const history = path.join(root, HISTORY_DIR);
  const plan = [];
  for (const name of fs.readdirSync(root)) {
    const from = path.join(root, name);
    if (isKept(name)) { plan.push({ name, action: 'keep', from, reason: 'system file' }); continue; }
    if (isAuthDb(name)) { plan.push({ name, action: 'archive', from, to: path.join(history, name === 'auth.db' ? 'legacy-auth.db' : `legacy-${name}`), reason: 'legacy account db' }); continue; }
    if (DROP_ENTRIES.includes(name)) { plan.push({ name, action: 'drop', from, reason: 'regenerated or diagnostic' }); continue; }
    if (ARCHIVE_ENTRIES.includes(name)) { plan.push({ name, action: 'archive', from, to: path.join(history, name), reason: 'historic migration artifact' }); continue; }
    if (name === 'workspaces' && fs.existsSync(path.join(from, 'general')) && fs.readdirSync(path.join(from, 'general')).length === 0) {
      plan.push({ name: 'workspaces/general', action: 'drop', from: path.join(from, 'general'), reason: 'empty legacy general workspace' });
    }
    if (MOVE_ENTRIES.includes(name)) { plan.push({ name, action: 'move', from, to: path.join(home, name), reason: 'user data' }); continue; }
    plan.push({ name, action: 'archive', from, to: path.join(history, 'unknown', name), reason: 'unknown entry' });
  }
  if (isNonEmptyDirOrFalse(path.join(root, ARCHIVES_CHILD))) {
    plan.push({ name: ARCHIVES_CHILD, action: 'move', from: path.join(root, ARCHIVES_CHILD), to: path.join(home, ARCHIVES_CHILD), reason: 'user data' });
  } else if (fs.existsSync(path.join(home, ARCHIVES_CHILD))) {
    plan.push({ name: ARCHIVES_CHILD, action: 'skip', from: path.join(root, ARCHIVES_CHILD), to: path.join(home, ARCHIVES_CHILD), reason: 'already-migrated' });
  }
  // Top-level user-data entries already moved into the home by an earlier, interrupted run.
  const present = new Set(plan.map((step) => step.name));
  for (const name of MOVE_ENTRIES) {
    const target = path.join(home, name);
    if (!present.has(name) && fs.existsSync(target)) {
      plan.push({ name, action: 'skip', from: path.join(root, name), to: target, reason: 'already-migrated' });
    }
  }
  const legacyGeneral = path.join(root, 'projects', createProjectId(root));
  if (fs.existsSync(legacyGeneral)) {
    plan.push({ name: `projects/${createProjectId(root)}`, action: 'move', from: legacyGeneral, to: path.join(home, 'projects', createProjectId(home)), reason: 'general container renamed for new home' });
  }
  // the renamed general container must run before the bulk projects/ move
  return plan.sort((a, b) => (a.name.startsWith('projects/') ? -1 : 0) - (b.name.startsWith('projects/') ? -1 : 0));
}
