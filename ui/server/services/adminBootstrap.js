// ui/server/services/adminBootstrap.js
import bcrypt from 'bcrypt';
import { ensureUserHomeSkeleton } from '../utils/pilotPaths.js';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_DEFAULT_PASSWORD = 'passok';

export function isReservedUsername(username) {
  return typeof username === 'string' && username.trim().toLowerCase() === ADMIN_USERNAME;
}

/**
 * Startup guarantee: the system always has an admin account.
 * - Empty users table → create `admin` (password from PILOTDECK_ADMIN_PASSWORD, else default).
 * - Users exist but no active admin → refuse to start (the operator either
 *   starts from a fresh PILOT_HOME or promotes an account by hand; the
 *   data-migration command arrives in the next plan).
 * - Existing admin → do nothing. Passwords are never re-synced on startup.
 */
export async function ensureAdminUser({
  userDb,
  env = process.env,
  bcryptHash = (password) => bcrypt.hash(password, 12),
  log = console.log,
  ensureHome = ensureUserHomeSkeleton,
} = {}) {
  if (!userDb.hasUsers()) {
    const fromEnv = typeof env.PILOTDECK_ADMIN_PASSWORD === 'string' ? env.PILOTDECK_ADMIN_PASSWORD : '';
    const password = fromEnv.length > 0 ? fromEnv : ADMIN_DEFAULT_PASSWORD;
    const usedDefaultPassword = password === ADMIN_DEFAULT_PASSWORD && fromEnv.length === 0;
    const hash = await bcryptHash(password);
    const admin = userDb.createUser(ADMIN_USERNAME, hash, 'admin');
    ensureHome(admin.id);
    log(`[INFO] Created administrator account "${ADMIN_USERNAME}".`);
    if (usedDefaultPassword) {
      log('[WARN] Administrator is using the default password. Set PILOTDECK_ADMIN_PASSWORD or change it after first login.');
    }
    return { created: true, usedDefaultPassword };
  }

  if (userDb.countActiveAdmins() === 0) {
    const error = new Error(
      'No active administrator account exists. Refusing to start. '
      + 'Start with a fresh PILOT_HOME (an admin is created automatically), or promote an existing account: '
      + 'sqlite3 <path-to-auth.db> "UPDATE users SET role=\'admin\' WHERE username=\'<name>\'". '
      + 'The data-migration command arrives in the next plan.',
    );
    error.code = 'NO_ACTIVE_ADMIN';
    throw error;
  }

  return { created: false, usedDefaultPassword: false };
}
