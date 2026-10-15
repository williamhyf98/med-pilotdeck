// ui/server/services/legacyMigration.js
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureUserHomeSkeleton, resolvePilotRoot } from '../utils/pilotPaths.js';
import { db, sessionNamesDb } from '../database/db.js';
import { LEGACY_DONE_MARKER, HISTORY_DIR, detectLegacyLayout, hasOtherUserHomes, planLegacyMigration } from './legacyLayout.js';

export { LEGACY_DONE_MARKER, detectLegacyLayout, planLegacyMigration };

function fail(message, cause) {
  const error = new Error(`Legacy storage migration failed: ${message}`);
  error.code = 'LEGACY_MIGRATION_FAILED';
  if (cause) error.cause = cause;
  return error;
}

// Spec 9.2 step 1 wants a hardlink copy: on the same filesystem the snapshot
// then costs no extra bytes. `fsp.cp` cannot hardlink, and COPYFILE_FICLONE
// silently degrades to a full byte copy inside Node, so walk the tree here and
// try `link` per file first. Symlinks are recreated, never followed.
async function copyIntoSnapshot(from, dest) {
  const stat = await fsp.lstat(from);
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const child of await fsp.readdir(from)) {
      await copyIntoSnapshot(path.join(from, child), path.join(dest, child));
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(from), dest);
    return;
  }
  try {
    await fsp.link(from, dest);
  } catch {
    // cross-device, hardlink-less filesystem, link limit reached, …: copy the
    // bytes (FICLONE is a free win where the filesystem supports reflinks).
    await fsp.copyFile(from, dest, fs.constants.COPYFILE_FICLONE);
  }
}

function snapshotSteps(plan) {
  return plan.filter((step) => step.action !== 'keep' && step.action !== 'skip' && fs.existsSync(step.from));
}

async function snapshot(root, plan, snapshotName, log) {
  const dir = path.join(root, 'archives', snapshotName);
  await fsp.mkdir(dir, { recursive: true });
  log(`[migration] legacy layout detected; snapshotting ${snapshotSteps(plan).length} entries into ${dir} ...`);
  for (const step of plan) {
    if (step.action === 'keep' || step.action === 'skip' || !fs.existsSync(step.from)) continue;
    const dest = path.join(dir, path.relative(root, step.from));
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await copyIntoSnapshot(step.from, dest);
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

async function lstatOrNull(target) {
  try { return await fsp.lstat(target); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

// Symlinks (either side) are leaves: never followed, moved intact when the name is free, else archived.
async function moveMerging(from, to, conflictDir, skipChild = () => false) {
  const fromStat = await fsp.lstat(from);
  const toStat = await lstatOrNull(to);
  if (!toStat) { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.rename(from, to); return; }
  // anything that is not a plain directory on both sides cannot be merged: keep the target, archive the legacy item
  if (!fromStat.isDirectory() || !toStat.isDirectory()) { await archiveConflict(from, conflictDir); return; }
  for (const child of await fsp.readdir(from)) {
    if (skipChild(child)) continue;
    await moveMerging(path.join(from, child), path.join(to, child), path.join(conflictDir, child));
  }
  await fsp.rmdir(from).catch(() => {});
}

// After the apply loop nothing of a `move` step may remain (an empty leftover dir is removed).
async function assertNoResidue(plan) {
  for (const step of plan) {
    if (step.action !== 'move') continue;
    const stat = await lstatOrNull(step.from);
    if (!stat) continue;
    if (stat.isDirectory() && (await fsp.readdir(step.from)).length === 0) {
      await fsp.rmdir(step.from);
      continue;
    }
    throw fail(`residue left at ${step.from}`);
  }
}

const hasTable = (legacy, name) => Boolean(
  legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),
);

function importSessionNames(legacy, adminId) {
  if (!hasTable(legacy, 'session_names')) return 0;
  let count = 0;
  for (const row of legacy.prepare('SELECT session_id, provider, custom_name FROM session_names').all()) {
    if (sessionNamesDb.getName(adminId, row.session_id, row.provider)) continue;
    sessionNamesDb.setName(adminId, row.session_id, row.provider, row.custom_name);
    count += 1;
  }
  return count;
}

const INSERT_API_KEY = `INSERT OR IGNORE INTO api_keys (user_id, key_name, api_key, created_at, last_used, is_active)
  VALUES (@userId, @keyName, @apiKey, COALESCE(@createdAt, CURRENT_TIMESTAMP), @lastUsed, @isActive)`;
const INSERT_CREDENTIAL = `INSERT OR IGNORE INTO user_credentials
  (user_id, credential_name, credential_type, credential_value, description, created_at, is_active)
  VALUES (@userId, @name, @type, @value, @description, COALESCE(@createdAt, CURRENT_TIMESTAMP), @isActive)`;
const flag = (value) => (value === 0 || value === false || value === '0' ? 0 : 1);

/**
 * The no-login era had exactly one account (`local`), so its API keys and
 * stored credentials are unambiguously the administrator's and are imported.
 * With several legacy accounts there is no safe owner: nothing is imported and
 * the operator is told, by username, what has to be re-created by hand. The
 * legacy database itself is archived either way (see the plan's `archive` step).
 */
function importLegacyOwnedRows(legacy, adminId, log) {
  if (!hasTable(legacy, 'users')) return;
  const usernames = legacy.prepare('SELECT username FROM users ORDER BY id').all().map((r) => r.username);
  if (usernames.length > 1) {
    const archived = path.join(HISTORY_DIR, 'legacy-auth.db');
    log('[migration] ======================================================================');
    log(`[migration] WARNING: the legacy auth.db held ${usernames.length} accounts: ${usernames.join(', ')}`);
    log('[migration] Their API keys and stored credentials were NOT imported: there is no');
    log('[migration] safe way to decide which of them the administrator inherits.');
    log(`[migration] The whole legacy database was archived to ${archived}.`);
    log('[migration] The administrator must re-create these accounts and their API keys.');
    log('[migration] ======================================================================');
    return;
  }
  if (usernames.length === 0) return;
  let keys = 0;
  if (hasTable(legacy, 'api_keys')) {
    const insert = db.prepare(INSERT_API_KEY);
    for (const row of legacy.prepare('SELECT * FROM api_keys').all()) {
      if (!row.api_key) continue;
      keys += insert.run({
        userId: adminId, keyName: row.key_name ?? 'legacy', apiKey: row.api_key,
        createdAt: row.created_at ?? null, lastUsed: row.last_used ?? null, isActive: flag(row.is_active),
      }).changes;
    }
  }
  let credentials = 0;
  if (hasTable(legacy, 'user_credentials')) {
    const insert = db.prepare(INSERT_CREDENTIAL);
    for (const row of legacy.prepare('SELECT * FROM user_credentials').all()) {
      if (!row.credential_type || !row.credential_value) continue;
      credentials += insert.run({
        userId: adminId, name: row.credential_name ?? row.credential_type, type: row.credential_type,
        value: row.credential_value, description: row.description ?? null,
        createdAt: row.created_at ?? null, isActive: flag(row.is_active),
      }).changes;
    }
  }
  log(`[migration] imported ${keys} api key(s) and ${credentials} credential(s) from legacy auth.db`);
}

function importLegacyAccountData(legacyDbPath, adminId, log) {
  const legacy = new Database(legacyDbPath, { readonly: true, fileMustExist: true });
  try {
    log(`[migration] imported ${importSessionNames(legacy, adminId)} session name(s) from legacy auth.db`);
    importLegacyOwnedRows(legacy, adminId, log);
  } finally {
    legacy.close();
  }
}

export async function migrateLegacyStorage({ userDb, env = process.env, log = console.log, now = () => new Date() }) {
  const root = resolvePilotRoot(env);
  if (fs.existsSync(path.join(root, LEGACY_DONE_MARKER))) return { skipped: true, reason: 'marker-present' };
  let admin;
  let plan;
  try {
    if (!detectLegacyLayout(root).present) return { skipped: true, reason: 'no-legacy-layout' };
    admin = userDb.getAdminUser();
    if (!admin) throw fail('no active administrator to own the legacy data');
    // Spec 9.1: a system that already carries other accounts was never
    // single-user. Re-running the migration there would relocate root-owned
    // directories (notably `archives/users/*`) into the admin's home.
    if (hasOtherUserHomes(root, admin.id)) {
      log('[migration] skipped: <root>/users/ already holds other accounts; the legacy migration only runs on a single-user root');
      return { skipped: true, reason: 'users-populated' };
    }
    ensureUserHomeSkeleton(admin.id, env);
    plan = planLegacyMigration({ root, adminId: admin.id, env });
  } catch (error) {
    throw error?.code === 'LEGACY_MIGRATION_FAILED' ? error : fail('planning', error);
  }
  const snapshotName = `legacy-${now().toISOString().replace(/[:.]/g, '-')}`;
  const snapshotDir = await snapshot(root, plan, snapshotName, log);
  log(`[migration] snapshot at ${snapshotDir}`);

  // Import before the legacy db file is moved away; skipped when already imported.
  const legacyDb = path.join(root, 'auth.db');
  if (fs.existsSync(legacyDb)) {
    try { importLegacyAccountData(legacyDb, admin.id, log); }
    catch (error) { throw fail('reading legacy auth.db', error); }
    // the read-only open may have created -wal/-shm sidecars after the plan was made
    for (const name of ['auth.db-wal', 'auth.db-shm']) {
      const from = path.join(root, name);
      if (fs.existsSync(from) && !plan.some((step) => step.name === name)) {
        plan.push({ name, action: 'archive', from, to: path.join(root, HISTORY_DIR, `legacy-${name}`), reason: 'legacy account db sidecar' });
      }
    }
  }

  const applied = [];
  for (const step of plan) {
    if (step.action === 'keep') continue;
    if (step.action === 'skip' || !fs.existsSync(step.from)) {
      applied.push({ name: step.name, action: 'skip', from: step.from, to: step.to ?? null, reason: 'already-migrated' });
      continue;
    }
    try {
      if (step.action === 'move') {
        await moveMerging(step.from, step.to, path.join(root, HISTORY_DIR, 'conflicts', path.relative(root, step.from)));
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
  try {
    await assertNoResidue(plan);
  } catch (error) {
    throw error?.code === 'LEGACY_MIGRATION_FAILED' ? error : fail('verifying residue', error);
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
