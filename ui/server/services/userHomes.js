/**
 * Per-user PilotDeck homes.
 *
 * Layout under the installation-wide home:
 *
 *   .pilotdeck-home/                 <- global, shared by everyone
 *   ├── auth.db                      accounts (never per-user)
 *   ├── pilotdeck.yaml               models / MCP / gateway, admin-owned
 *   ├── plugins/                     shared plugin bundles (med-tools)
 *   ├── skills/                      legacy private skills; never auto-copied
 *   ├── shared/skills/               explicitly published templates
 *   ├── logs/ telemetry/ router/     installation-wide runtime state
 *   └── users/
 *       └── <userId>/                <- a complete, self-sufficient home
 *           ├── projects/            projects + chat transcripts
 *           ├── workspaces/          agent cwd: inbox / exports / scratch
 *           ├── memory/              project memory + global identity memory
 *           ├── skills/              private (seeded from the template)
 *           ├── archives/ cron/ logs/
 *           ├── plugins/             -> symlink/junction to the shared dir
 *           └── server-token         this user's gateway token
 *
 * A user home is a valid `PILOT_HOME` on its own, which is what lets us
 * hand it to a dedicated gateway process without the engine ever
 * learning that users exist. `pilotdeck.yaml` is the one shared file the
 * engine still expects inside the home; rather than copying it (which
 * would fork admin config N ways) the gateway is spawned with
 * `PILOTDECK_CONFIG_PATH` pointing back at the global file.
 */
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveGlobalPilotHome } from '../utils/pilotPaths.js';

export const USERS_DIR_NAME = 'users';

/** Directories every user home owns privately. */
const USER_HOME_DIRS = Object.freeze([
  'projects',
  'memory',
  'skills',
  'archives',
  'cron',
  'logs',
  path.join('workspaces', 'general', 'inbox'),
  path.join('workspaces', 'general', 'exports'),
  path.join('workspaces', 'general', 'scratch', 'qa'),
  path.join('workspaces', 'general', 'scratch', 'work'),
  path.join('workspaces', 'general', 'scratch', 'preview'),
  path.join('workspaces', 'general', 'scratch', 'tool-results'),
]);

/**
 * Top-level entries that stay in the global home and are deliberately
 * NOT duplicated per user. Kept here so the migration below knows what
 * to leave behind.
 */
export const SHARED_HOME_ENTRIES = Object.freeze([
  'auth.db',
  'pilotdeck.yaml',
  'plugins',
  'skills',
  'server-token',
  'logs',
  'telemetry',
  'router',
  'channels',
  USERS_DIR_NAME,
]);

/** Legacy data needs explicit ownership assignment by an operator. */
const LEGACY_DATA_DIRS = Object.freeze(['projects', 'workspaces', 'memory', 'archives', 'cron', 'skills']);

const PROVISION_MARKER = '.provisioned';

/** @param {string} [globalHome] */
export function usersRootDir(globalHome = resolveGlobalPilotHome()) {
  return path.join(globalHome, USERS_DIR_NAME);
}

/**
 * Absolute private home for a user id. Ids come from SQLite AUTOINCREMENT
 * so they are always positive integers; anything else is a bug upstream
 * and must not be turned into a path.
 *
 * @param {number|string} userId
 * @param {string} [globalHome]
 * @returns {string}
 */
export function resolveUserHome(userId, globalHome = resolveGlobalPilotHome()) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid user id for home resolution: ${JSON.stringify(userId)}`);
  }
  return path.join(usersRootDir(globalHome), String(id));
}

/** The shared skill library new users are seeded from. */
export function skillTemplateDir(globalHome = resolveGlobalPilotHome()) {
  return path.join(globalHome, 'shared', 'skills');
}

async function linkOrCopyDir(target, linkPath) {
  if (existsSync(linkPath)) return;
  if (!existsSync(target)) return;
  try {
    // 'junction' is the only link type Windows grants without developer
    // mode or elevation; on POSIX Node ignores the hint and makes a
    // normal symlink.
    await fs.symlink(target, linkPath, 'junction');
    return;
  } catch {
    // Fall through: a copy is heavier but always works.
  }
  try {
    await fs.cp(target, linkPath, { recursive: true, dereference: false });
  } catch (error) {
    console.warn(`[user-homes] could not share ${target} -> ${linkPath}: ${error.message}`);
  }
}

/** userHome -> Promise, so concurrent requests provision once. */
const provisioning = new Map();

/**
 * Create (or top up) a user's private home. Idempotent and memoised per
 * process, so the hot path costs a Map lookup rather than a dozen
 * `mkdir` syscalls per request.
 *
 * @param {number} userId
 * @param {{ globalHome?: string, seedSkills?: boolean }} [options]
 * @returns {Promise<string>} the user home path
 */
export function ensureUserHome(userId, options = {}) {
  const globalHome = options.globalHome ?? resolveGlobalPilotHome();
  const home = resolveUserHome(userId, globalHome);
  const cached = provisioning.get(home);
  if (cached) return cached;
  const pending = provisionUserHome(home, globalHome, options).catch((error) => {
    // Don't cement a transient failure (full disk, EPERM): let the next
    // caller retry instead of leaving the user permanently broken.
    provisioning.delete(home);
    throw error;
  });
  provisioning.set(home, pending);
  return pending;
}

/** Drop the memoised provisioning result (used by tests and teardown). */
export function forgetProvisionedHomes() {
  provisioning.clear();
}

async function provisionUserHome(home, globalHome, options = {}) {
  const marker = path.join(home, PROVISION_MARKER);
  const firstRun = !existsSync(marker);

  for (const dir of USER_HOME_DIRS) {
    await fs.mkdir(path.join(home, dir), { recursive: true });
  }

  // Shared plugin bundles: linked, so an admin installing a plugin
  // reaches every user without a per-user copy going stale.
  await linkOrCopyDir(path.join(globalHome, 'plugins'), path.join(home, 'plugins'));

  // Skills are seeded ONCE. After that the copy is the user's own —
  // later template edits deliberately do not overwrite their work.
  if (firstRun && options.seedSkills === true) {
    await seedUserSkills(home, globalHome);
  }

  if (firstRun) {
    await fs.writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
  }
  return home;
}

/**
 * Copy the template skill library into a fresh user home. Skips any
 * slug the user already has so a re-run can never clobber their edits.
 */
export async function seedUserSkills(userHome, globalHome = resolveGlobalPilotHome()) {
  const templateDir = skillTemplateDir(globalHome);
  if (!existsSync(templateDir)) return 0;
  const targetDir = path.join(userHome, 'skills');
  await fs.mkdir(targetDir, { recursive: true });

  let copied = 0;
  let entries = [];
  try {
    entries = await fs.readdir(templateDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dest = path.join(targetDir, entry.name);
    if (existsSync(dest)) continue;
    try {
      await fs.cp(path.join(templateDir, entry.name), dest, { recursive: true });
      copied += 1;
    } catch (error) {
      console.warn(`[user-homes] skill seed failed for ${entry.name}: ${error.message}`);
    }
  }
  return copied;
}

/** User ids that already have a home on disk. */
export async function listProvisionedUserIds(globalHome = resolveGlobalPilotHome()) {
  const root = usersRootDir(globalHome);
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function containsLegacyData(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Empty bootstrap directory scaffolding is not legacy user data.
      // Symlinks count as data; never follow them during this scan.
      if (!entry.isDirectory() || await containsLegacyData(path.join(dir, entry.name))) return true;
    }
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error; // Unreadable storage must not be mistaken for an empty install.
  }
}

/**
 * Read-only startup/status inspection. Old migration markers do not prove
 * success (the old migrator wrote them even after partial failure).
 * The explicit, verified migration tool will introduce a versioned manifest.
 */
export async function getUserStorageStatus(globalHome = resolveGlobalPilotHome()) {
  const legacyDirectories = [];
  for (const name of LEGACY_DATA_DIRS) {
    if (await containsLegacyData(path.join(globalHome, name))) legacyDirectories.push(name);
  }
  return { migrationRequired: legacyDirectories.length > 0, legacyDirectories };
}

export async function assertUserStorageReady() {
  if ((await getUserStorageStatus()).migrationRequired) {
    throw Object.assign(new Error('发现旧版用户数据，需管理员明确归属并迁移后才能启用多用户服务；未移动任何旧数据。'), {
      code: 'LEGACY_STORAGE_MIGRATION_REQUIRED',
    });
  }
}
