// ui/server/services/storageUsage.js
//
// How much disk a user's home occupies, for the admin user list. This is the
// `du -s <root>/users/<id>` number, computed in-process:
//
//   * `lstat`, never `stat` — a symlink counts as the link itself, so a link
//     into /usr or into another user's home can neither inflate the number nor
//     walk us out of the tree. (`ensureUserHomeSkeleton` creates exactly such a
//     link for the shared `plugins` directory.)
//   * errors are swallowed per entry: a file deleted mid-walk, or one we may
//     not read, must not fail the admin list.
//   * results are cached for 60 s per user, because the admin page polls and
//     walking a large home is the expensive part of the request.
//
// A3 (design §9.2.1) added three things on top of the plain `du` number:
//   * `inboxBytes` — the part of the home under `<workspaces>/…/inbox`, which is
//     the only slice that never gets cleaned automatically;
//   * archived homes (`<root>/archives/users/<id>-<stamp>`) still count towards
//     the deployment total, otherwise the sum silently drops when an account is
//     deleted;
//   * the per-user warning threshold, read from `workspace.quota.userTotalMaxBytes`
//     in pilotdeck.yaml, defaulting to the 20 GiB from the design.
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { resolvePilotRoot, resolveUserHome } from '../utils/pilotPaths.js';
import {
  DEFAULT_WORKSPACE_LIMITS,
  getWorkspaceLimits,
  invalidateWorkspaceLimitsCache,
} from './workspaceLimits.js';

const CACHE_TTL_MS = 60_000;
/** Design §9.2 default: "单用户总量告警值 20 GB". */
export const DEFAULT_USER_TOTAL_WARNING_BYTES = DEFAULT_WORKSPACE_LIMITS.userTotalMaxBytes;

/** userId → { bytes, inboxBytes, expiresAt } */
const cache = new Map();
/** { byUser: Map<string, number>, expiresAt } for `<root>/archives/users`. */
let archivesCache = null;

/**
 * True when `parts` (path segments relative to the scanned root) sit inside an
 * `inbox/` directory of a workspace:
 *
 *   workspaces/<id>/inbox/…                 → parts[2] === 'inbox'
 *   workspaces/<typeKey>/<id>/inbox/…       → parts[3] === 'inbox'
 *
 * Deeper paths keep the same marker at the same index, so descendants match too.
 */
function isInboxRelative(parts) {
  return parts[0] === 'workspaces' && (parts[2] === 'inbox' || parts[3] === 'inbox');
}

async function walkDirectory(dir, parts, acc) {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const childParts = [...parts, entry.name];
    try {
      if (entry.isSymbolicLink()) {
        const linkStat = await fsPromises.lstat(full);
        acc.bytes += linkStat.size;
        if (isInboxRelative(childParts)) acc.inboxBytes += linkStat.size;
        continue;
      }
      if (entry.isDirectory()) {
        await walkDirectory(full, childParts, acc);
        continue;
      }
      const stat = await fsPromises.lstat(full);
      if (stat.isSymbolicLink() || stat.isFile()) {
        acc.bytes += stat.size;
        if (isInboxRelative(childParts)) acc.inboxBytes += stat.size;
      }
    } catch {
      // Entry vanished or is unreadable — it contributes nothing.
    }
  }
}

/**
 * Bytes occupied by `<root>/users/<userId>`, split by what the admin page needs.
 * Returns zeros when the home does not exist yet. Never throws.
 *
 * @param {number|string} userId
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<{ bytes: number, inboxBytes: number }>}
 */
export async function getUserStorageBreakdown(userId, { now = Date.now } = {}) {
  const key = String(userId);
  const hit = cache.get(key);
  const at = now();
  if (hit && hit.expiresAt > at) return { bytes: hit.bytes, inboxBytes: hit.inboxBytes };

  const acc = { bytes: 0, inboxBytes: 0 };
  try {
    const home = resolveUserHome(userId);
    const stat = await fsPromises.lstat(home).catch(() => null);
    if (stat && stat.isDirectory()) await walkDirectory(home, [], acc);
  } catch {
    acc.bytes = 0;
    acc.inboxBytes = 0;
  }
  cache.set(key, { bytes: acc.bytes, inboxBytes: acc.inboxBytes, expiresAt: at + CACHE_TTL_MS });
  return { bytes: acc.bytes, inboxBytes: acc.inboxBytes };
}

/**
 * Bytes occupied by `<root>/users/<userId>`. Returns 0 when the home does not
 * exist yet. Never throws.
 *
 * @param {number|string} userId
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<number>}
 */
export async function getUserStorageBytes(userId, options) {
  const { bytes } = await getUserStorageBreakdown(userId, options);
  return bytes;
}

function archivedUsersDir() {
  return path.join(resolvePilotRoot(), 'archives', 'users');
}

/**
 * Bytes still held by deleted users: `<root>/archives/users/<id>-<stamp>`.
 * Keyed by user id as a string, because the account row survives the delete
 * (it is only deactivated) while its home was moved here.
 *
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<Map<string, number>>}
 */
export async function listArchivedUserBytes({ now = Date.now } = {}) {
  const at = now();
  if (archivesCache && archivesCache.expiresAt > at) return archivesCache.byUser;

  const byUser = new Map();
  const dir = archivedUsersDir();
  let entries = [];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // `<id>-<ISO stamp with : . replaced by ->`; the trailing dash keeps user 1
    // from swallowing the archive of user 12.
    const match = /^(\d+)-/.exec(entry.name);
    if (!match) continue;
    const acc = { bytes: 0, inboxBytes: 0 };
    await walkDirectory(path.join(dir, entry.name), [], acc);
    byUser.set(match[1], (byUser.get(match[1]) ?? 0) + acc.bytes);
  }

  archivesCache = { byUser, expiresAt: at + CACHE_TTL_MS };
  return byUser;
}

/**
 * Per-user total-memory warning threshold (design §9.2, `workspace.quota.
 * userTotalMaxBytes`). Read from pilotdeck.yaml; falls back to 20 GiB so the
 * admin page works on a box without the quota block. Never throws.
 *
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<number>}
 */
export async function getUserTotalWarningBytes({ now = Date.now } = {}) {
  const limits = await getWorkspaceLimits({ now });
  return limits.userTotalMaxBytes;
}

/**
 * Drop the cached figure for one user (after a delete/archive), or everything
 * when the admin asks for a manual refresh.
 */
export function invalidateStorageCache(userId) {
  if (userId === undefined) {
    cache.clear();
    archivesCache = null;
    invalidateWorkspaceLimitsCache();
    return;
  }
  cache.delete(String(userId));
}
