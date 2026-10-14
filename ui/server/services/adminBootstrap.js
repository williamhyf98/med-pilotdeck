// ui/server/services/adminBootstrap.js
import bcrypt from 'bcrypt';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_DEFAULT_PASSWORD = 'passok';

export function isReservedUsername(username) {
  return typeof username === 'string' && username.trim().toLowerCase() === ADMIN_USERNAME;
}

/**
 * Startup guarantee: the system always has an admin account.
 * - Empty users table → create `admin` (password from PILOTDECK_ADMIN_PASSWORD, else default).
 * - Users exist but no active admin → refuse to start (operator must run the
 *   migration command with --assign-admin; see plan 2).
 * - Existing admin → do nothing. Passwords are never re-synced on startup.
 */
export async function ensureAdminUser({
  userDb,
  env = process.env,
  bcryptHash = (password) => bcrypt.hash(password, 12),
  log = console.log,
} = {}) {
  if (!userDb.hasUsers()) {
    const fromEnv = typeof env.PILOTDECK_ADMIN_PASSWORD === 'string' ? env.PILOTDECK_ADMIN_PASSWORD : '';
    const password = fromEnv.length > 0 ? fromEnv : ADMIN_DEFAULT_PASSWORD;
    const usedDefaultPassword = password === ADMIN_DEFAULT_PASSWORD && fromEnv.length === 0;
    const hash = await bcryptHash(password);
    userDb.createUser(ADMIN_USERNAME, hash, 'admin');
    log(`[INFO] Created administrator account "${ADMIN_USERNAME}".`);
    if (usedDefaultPassword) {
      log('[WARN] Administrator is using the default password. Set PILOTDECK_ADMIN_PASSWORD or change it after first login.');
    }
    return { created: true, usedDefaultPassword };
  }

  if (userDb.countActiveAdmins() === 0) {
    const error = new Error(
      'No active administrator account exists. Refusing to start. Run `node scripts/migrate-user-storage.mjs --assign-admin <username>` to promote an existing account.',
    );
    error.code = 'NO_ACTIVE_ADMIN';
    throw error;
  }

  return { created: false, usedDefaultPassword: false };
}
