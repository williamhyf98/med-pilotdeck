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

const { values } = parseArgs({ options: {
  'pilot-home': { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  'assign-admin': { type: 'string' }, 'seed-user-for-test': { type: 'string' },
} });
const pilotHome = path.resolve((values['pilot-home'] ?? process.env.PILOT_HOME ?? path.join(os.homedir(), '.pilotdeck')).replace(/^~(?=$|\/)/, os.homedir()));
process.env.PILOT_HOME = pilotHome;
// db.js opens the database at import time: pin it to <pilotHome>/system/auth.db.
process.env.DATABASE_PATH = '';

// db.js prints banners with console.log; keep stdout reserved for the report.
console.log = (...args) => console.error(...args);

const report = { pilotHome, dryRun: values['dry-run'] };
const finish = (code) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => process.exit(code));
const nothingToDo = () => {
  report.result = 'nothing-to-do';
  // A requested promotion counts as work done even when there is no legacy data.
  finish(values['assign-admin'] ? 0 : 2);
};

async function main() {
  const { initializeDatabase, userDb } = await import('../ui/server/database/db.js');
  const { ensureAdminUser } = await import('../ui/server/services/adminBootstrap.js');
  const { migrateLegacyStorage, planLegacyMigration, detectLegacyLayout, LEGACY_DONE_MARKER } = await import('../ui/server/services/legacyMigration.js');
  const { resolvePilotRoot } = await import('../ui/server/utils/pilotPaths.js');
  const log = (m) => console.error(m);

  await initializeDatabase();

  if ((process.env.NODE_ENV === 'test' || values['seed-user-for-test']) && values['seed-user-for-test']) {
    // Test-only: a non-admin account plus a deactivated admin ("users but no administrator").
    // bcrypt is a dependency of ui/, so resolve it from there.
    const bcrypt = createRequire(new URL('../ui/package.json', import.meta.url))('bcrypt');
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
    if (!values['dry-run']) { userDb.setRole(target.id, 'admin'); userDb.setActive(target.id, true); userDb.bumpTokenVersion(target.id); }
    report.promoted = target.username;
  }

  let adminWillBeCreated = false;
  if (!userDb.hasUsers()) {
    // Fresh system database: the administrator is seeded exactly as at server startup.
    if (values['dry-run']) adminWillBeCreated = true;
    else await ensureAdminUser({ userDb, log });
  } else if (!target && !userDb.getAdminUser()) {
    throw Object.assign(new Error('no active administrator; pass --assign-admin <username>'), { exitCode: 1 });
  }

  const root = resolvePilotRoot(process.env);
  if (fs.existsSync(path.join(root, LEGACY_DONE_MARKER)) || !detectLegacyLayout(root).present) {
    return nothingToDo();
  }
  if (values['dry-run']) {
    // The first account created in an empty users table gets id 1.
    const adminId = userDb.getAdminUser()?.id ?? target?.id ?? (adminWillBeCreated ? 1 : null);
    if (adminWillBeCreated) report.adminWillBeCreated = true;
    report.plan = planLegacyMigration({ root, adminId }).map(({ name, action, to, reason }) => ({ name, action, to: to ?? null, reason }));
    return finish(0);
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
