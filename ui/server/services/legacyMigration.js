// ui/server/services/legacyMigration.js
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createProjectId, ensureUserHomeSkeleton, resolvePilotRoot, resolveUserHome } from '../utils/pilotPaths.js';
import { sessionNamesDb } from '../database/db.js';

export const LEGACY_DONE_MARKER = path.join('system', 'migration', 'legacy-done.json');
const HISTORY_DIR = path.join('system', 'migration', 'history');

const MOVE_ENTRIES = ['projects', 'workspaces', 'memory', 'skills', 'archives', 'logs', '.pilotdeck', '.tmp', '.legacy-bundled-skills-migrated-v1'];
const DROP_ENTRIES = ['router', 'telemetry', 'cron', 'server-token'];
const ARCHIVE_ENTRIES = ['migration-backups', 'migration-reports', '.workspace-migration-v1.json'];
const KEEP_ENTRIES = ['pilotdeck.yaml', 'plugins', 'system', 'users'];
const isKept = (name) => KEEP_ENTRIES.includes(name) || name.startsWith('pilotdeck.yaml.bak');
const isAuthDb = (name) => name === 'auth.db' || name === 'auth.db-wal' || name === 'auth.db-shm';
// Snapshots live in <root>/archives/legacy-<ISO stamp>; they must never be moved or re-copied.
const isSnapshotDirName = (name) => /^legacy-\d{4}-\d{2}-\d{2}T/.test(name);

function fail(message, cause) {
  const error = new Error(`Legacy storage migration failed: ${message}`);
  error.code = 'LEGACY_MIGRATION_FAILED';
  if (cause) error.cause = cause;
  return error;
}

function dirHasData(dir, name) {
  const children = fs.readdirSync(dir);
  return (name === 'archives' ? children.filter((c) => !isSnapshotDirName(c)) : children).length > 0;
}

export function detectLegacyLayout(root) {
  if (!fs.existsSync(root)) return { present: false, entries: [] };
  const entries = fs.readdirSync(root).filter((name) => !isKept(name));
  const dataDirs = entries.filter((n) => MOVE_ENTRIES.includes(n)
    && fs.statSync(path.join(root, n)).isDirectory()
    && dirHasData(path.join(root, n), n));
  return { present: dataDirs.length > 0 || entries.some(isAuthDb), entries };
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
  const legacyGeneral = path.join(root, 'projects', createProjectId(root));
  if (fs.existsSync(legacyGeneral)) {
    plan.push({ name: `projects/${createProjectId(root)}`, action: 'move', from: legacyGeneral, to: path.join(home, 'projects', createProjectId(home)), reason: 'general container renamed for new home' });
  }
  // the renamed general container must run before the bulk projects/ move
  return plan.sort((a, b) => (a.name.startsWith('projects/') ? -1 : 0) - (b.name.startsWith('projects/') ? -1 : 0));
}

const CLONE_FALLBACK_CODES = new Set(['ENOTSUP', 'EXDEV', 'EOPNOTSUPP', 'ENOSYS', 'EPERM']);

async function copyIntoSnapshot(from, dest) {
  try {
    await fsp.cp(from, dest, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, errorOnExist: false, force: false });
  } catch (error) {
    // Filesystems without reflink support (e.g. ext4): fall back to a plain copy.
    if (!(CLONE_FALLBACK_CODES.has(error?.code) || String(error?.code ?? '').startsWith('ERR_FS_CP_'))) throw error;
    await fsp.cp(from, dest, { recursive: true, errorOnExist: false, force: false });
  }
}

async function snapshot(root, plan, stamp) {
  const dir = path.join(root, 'archives', `legacy-${stamp}`);
  await fsp.mkdir(dir, { recursive: true });
  for (const step of plan) {
    if (step.action === 'keep' || !fs.existsSync(step.from)) continue;
    const dest = path.join(dir, path.relative(root, step.from));
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (step.name === 'archives') {
        // the snapshot lives inside archives/: copy children individually, skipping snapshots
        for (const child of await fsp.readdir(step.from)) {
          if (isSnapshotDirName(child)) continue;
          await fsp.mkdir(dest, { recursive: true });
          await copyIntoSnapshot(path.join(step.from, child), path.join(dest, child));
        }
      } else {
        await copyIntoSnapshot(step.from, dest);
      }
    } catch (error) {
      throw fail(`snapshot of ${step.name}`, error);
    }
  }
  return dir;
}

async function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  for (let i = 1; ; i += 1) {
    const candidate = `${target}.${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

async function archiveConflict(from, conflictDir) {
  const target = await uniquePath(conflictDir);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rename(from, target);
}

async function moveMerging(from, to, conflictDir, skipChild = () => false) {
  if (!fs.existsSync(to)) { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.rename(from, to); return; }
  const [fromStat, toStat] = await Promise.all([fsp.stat(from), fsp.stat(to)]);
  // a file on either side cannot be merged: keep the target, archive the legacy item
  if (!fromStat.isDirectory() || !toStat.isDirectory()) { await archiveConflict(from, conflictDir); return; }
  for (const child of await fsp.readdir(from)) {
    if (skipChild(child)) continue;
    await moveMerging(path.join(from, child), path.join(to, child), path.join(conflictDir, child));
  }
  await fsp.rmdir(from).catch(() => {});
}

function importLegacySessionNames(legacyDbPath, adminId) {
  const legacy = new Database(legacyDbPath, { readonly: true, fileMustExist: true });
  try {
    const hasTable = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_names'").get();
    if (!hasTable) return 0;
    let count = 0;
    for (const row of legacy.prepare('SELECT session_id, provider, custom_name FROM session_names').all()) {
      if (sessionNamesDb.getName(adminId, row.session_id, row.provider)) continue;
      sessionNamesDb.setName(adminId, row.session_id, row.provider, row.custom_name);
      count += 1;
    }
    return count;
  } finally {
    legacy.close();
  }
}

export async function migrateLegacyStorage({ userDb, env = process.env, log = console.log, now = () => new Date() }) {
  const root = resolvePilotRoot(env);
  if (fs.existsSync(path.join(root, LEGACY_DONE_MARKER))) return { skipped: true, reason: 'marker-present' };
  const detected = detectLegacyLayout(root);
  if (!detected.present) return { skipped: true, reason: 'no-legacy-layout' };
  const admin = userDb.getAdminUser();
  if (!admin) throw fail('no active administrator to own the legacy data');

  ensureUserHomeSkeleton(admin.id, env);
  const plan = planLegacyMigration({ root, adminId: admin.id, env });
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = await snapshot(root, plan, stamp);
  log(`[migration] legacy layout detected; snapshot at ${snapshotDir}`);

  // Import before the legacy db file is moved away; skipped when already imported.
  const legacyDb = path.join(root, 'auth.db');
  if (fs.existsSync(legacyDb)) {
    try { log(`[migration] imported ${importLegacySessionNames(legacyDb, admin.id)} session name(s) from legacy auth.db`); }
    catch (error) { throw fail('reading legacy auth.db', error); }
  }

  const applied = [];
  for (const step of plan) {
    if (step.action === 'keep') continue;
    if (!fs.existsSync(step.from)) { applied.push({ name: step.name, action: 'skip', from: step.from, to: step.to ?? null, reason: 'already-migrated' }); continue; }
    try {
      if (step.action === 'move') {
        await moveMerging(
          step.from,
          step.to,
          path.join(root, HISTORY_DIR, 'conflicts', path.relative(root, step.from)),
          step.name === 'archives' ? isSnapshotDirName : undefined,
        );
      } else if (step.action === 'archive') {
        await fsp.mkdir(path.dirname(step.to), { recursive: true });
        await fsp.rename(step.from, step.to);
      } else if (step.action === 'drop') {
        await fsp.rm(step.from, { recursive: true, force: true });
      }
      applied.push({ name: step.name, action: step.action, from: step.from, to: step.to ?? null });
      log(`[migration] ${step.action.padEnd(7)} ${step.name}`);
    } catch (error) {
      throw fail(`${step.action} ${step.name}`, error);
    }
  }
  const markerPath = path.join(root, LEGACY_DONE_MARKER);
  try {
    await fsp.mkdir(path.dirname(markerPath), { recursive: true });
    await fsp.writeFile(markerPath, JSON.stringify({ at: now().toISOString(), adminId: admin.id, snapshotDir, applied }, null, 2));
  } catch (error) {
    throw fail('writing completion marker', error);
  }
  log(`[migration] done; ${applied.length} step(s), marker written`);
  return { skipped: false, snapshotDir, applied };
}
