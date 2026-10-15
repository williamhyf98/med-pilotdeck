#!/usr/bin/env node
// Operator command: move a legacy single-user PILOT_HOME layout into the
// administrator's per-user home (the same migration the UI server runs on
// startup), optionally promoting an existing account to administrator first.
//
//   node scripts/migrate-user-storage.mjs [--pilot-home <dir>] [--dry-run] [--assign-admin <username>]
//
// Exactly one JSON report is printed on stdout on every exit path; all other
// output goes to stderr. Exit codes: 0 done (or --assign-admin handled),
// 1 failure, 2 nothing to do.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const report = {};
const finish = (code) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => process.exit(code));

let values;
try {
  ({ values } = parseArgs({ options: {
    'pilot-home': { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    'assign-admin': { type: 'string' }, 'seed-user-for-test': { type: 'string' },
  } }));
} catch (error) {
  report.error = error.message;
  finish(1);
  await new Promise(() => {}); // finish() exits the process once stdout is flushed
}
const pilotHome = path.resolve((values['pilot-home'] ?? process.env.PILOT_HOME ?? path.join(os.homedir(), '.pilotdeck')).replace(/^~(?=$|\/)/, os.homedir()));
process.env.PILOT_HOME = pilotHome;
// db.js opens the database at import time: pin it to <pilotHome>/system/auth.db.
process.env.DATABASE_PATH = '';

// db.js prints banners with console.log; keep stdout reserved for the report.
console.log = (...args) => console.error(...args);

report.pilotHome = pilotHome;
report.dryRun = values['dry-run'];
const nothingToDo = () => {
  report.result = 'nothing-to-do';
  // A requested promotion counts as work done even when there is no legacy data.
  finish(values['assign-admin'] ? 0 : 2);
};
const bcryptFromUi = () => createRequire(new URL('../ui/package.json', import.meta.url))('bcrypt');

/**
 * --dry-run must not write anything, and importing db.js creates system/auth.db
 * (plus app_config and migrations). So the dry-run reads accounts from a private
 * copy of an existing auth.db, or assumes a fresh install when there is none.
 */
function readAccountsForDryRun(root, assignAdmin) {
  const dbFile = path.join(root, 'system', 'auth.db');
  if (!fs.existsSync(dbFile)) return { fresh: true, admin: null, target: null };
  const Database = createRequire(new URL('../ui/package.json', import.meta.url))('better-sqlite3');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-dryrun-'));
  try {
    for (const suffix of ['', '-wal']) {
      if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, path.join(tmp, `auth.db${suffix}`));
    }
    const db = new Database(path.join(tmp, 'auth.db'));
    try {
      let count = 0; let admin = null; let target = null;
      try {
        count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
        admin = db.prepare("SELECT id, username FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1").get() ?? null;
        if (assignAdmin) target = db.prepare('SELECT id, username FROM users WHERE username = ?').get(assignAdmin) ?? null;
      } catch { /* users table not created yet: behaves like an empty database */ }
      return { fresh: count === 0, admin, target };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function dryRun() {
  const { detectLegacyLayout, planLegacyMigration, LEGACY_DONE_MARKER } = await import('../ui/server/services/legacyLayout.js');
  const { resolvePilotRoot } = await import('../ui/server/utils/pilotPaths.js');
  const root = resolvePilotRoot(process.env);
  const { fresh, admin, target } = readAccountsForDryRun(root, values['assign-admin']);
  if (values['assign-admin']) {
    if (!target) throw Object.assign(new Error(`no such user: ${values['assign-admin']}`), { exitCode: 1 });
    report.promoted = target.username;
  }
  if (fresh) report.adminWillBeCreated = true;
  else if (!target && !admin) throw Object.assign(new Error('no active administrator; pass --assign-admin <username>'), { exitCode: 1 });
  if (fs.existsSync(path.join(root, LEGACY_DONE_MARKER)) || !detectLegacyLayout(root).present) return nothingToDo();
  // The first account created in an empty users table gets id 1.
  const adminId = admin?.id ?? target?.id ?? 1;
  report.plan = planLegacyMigration({ root, adminId }).map(({ name, action, to, reason }) => ({ name, action, to: to ?? null, reason }));
  return finish(0);
}

async function main() {
  if (values['dry-run']) return dryRun();
  const { initializeDatabase, userDb } = await import('../ui/server/database/db.js');
  const { ensureAdminUser } = await import('../ui/server/services/adminBootstrap.js');
  const { migrateLegacyStorage, detectLegacyLayout, LEGACY_DONE_MARKER } = await import('../ui/server/services/legacyMigration.js');
  const { resolvePilotRoot } = await import('../ui/server/utils/pilotPaths.js');
  const log = (m) => console.error(m);

  await initializeDatabase();

  if (values['seed-user-for-test']) {
    // Test-only: a non-admin account plus a deactivated admin ("users but no administrator").
    if (process.env.NODE_ENV !== 'test') throw Object.assign(new Error('--seed-user-for-test requires NODE_ENV=test'), { exitCode: 1 });
    const bcrypt = bcryptFromUi();
    await ensureAdminUser({ userDb, log, bcryptHash: (p) => bcrypt.hash(p, 4) });
    const u = userDb.createUser(values['seed-user-for-test'], await bcrypt.hash('x', 4), 'user');
    userDb.setActive(userDb.getAdminUser().id, false);
    report.seeded = u.username;
    return finish(0);
  }

  let target = null;
  if (values['assign-admin']) {
    target = userDb.getUserByUsername(values['assign-admin']);
    if (!target) throw Object.assign(new Error(`no such user: ${values['assign-admin']}`), { exitCode: 1 });
    userDb.setRole(target.id, 'admin'); userDb.setActive(target.id, true); userDb.bumpTokenVersion(target.id);
    report.promoted = target.username;
  }

  if (!userDb.hasUsers()) {
    // Fresh system database: the administrator is seeded exactly as at server startup.
    await ensureAdminUser({ userDb, log });
  } else if (!target && !userDb.getAdminUser()) {
    throw Object.assign(new Error('no active administrator; pass --assign-admin <username>'), { exitCode: 1 });
  }

  const root = resolvePilotRoot(process.env);
  if (fs.existsSync(path.join(root, LEGACY_DONE_MARKER)) || !detectLegacyLayout(root).present) {
    return nothingToDo();
  }
  const result = await migrateLegacyStorage({ userDb, log });
  report.result = result;
  if (result.skipped) return nothingToDo();
  return finish(0);
}

try {
  await main();
} catch (error) {
  report.error = error.message;
  if (error.code) report.code = error.code;
  finish(error.exitCode ?? 1);
}
