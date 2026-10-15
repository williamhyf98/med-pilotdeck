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
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { resolveUserHome } from '../utils/pilotPaths.js';

const CACHE_TTL_MS = 60_000;

/** userId → { bytes, expiresAt } */
const cache = new Map();

async function sumDirectory(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        const linkStat = await fsPromises.lstat(full);
        total += linkStat.size;
        continue;
      }
      if (entry.isDirectory()) {
        total += await sumDirectory(full);
        continue;
      }
      const stat = await fsPromises.lstat(full);
      if (stat.isSymbolicLink() || stat.isFile()) total += stat.size;
    } catch {
      // Entry vanished or is unreadable — it contributes nothing.
    }
  }
  return total;
}

/**
 * Bytes occupied by `<root>/users/<userId>`. Returns 0 when the home does not
 * exist yet. Never throws.
 *
 * @param {number|string} userId
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<number>}
 */
export async function getUserStorageBytes(userId, { now = Date.now } = {}) {
  const key = String(userId);
  const hit = cache.get(key);
  const at = now();
  if (hit && hit.expiresAt > at) return hit.bytes;

  let bytes = 0;
  try {
    const home = resolveUserHome(userId);
    const stat = await fsPromises.lstat(home).catch(() => null);
    if (stat && stat.isDirectory()) bytes = await sumDirectory(home);
  } catch {
    bytes = 0;
  }
  cache.set(key, { bytes, expiresAt: at + CACHE_TTL_MS });
  return bytes;
}

/** Drop the cached figure for one user (after a delete/archive), or for all. */
export function invalidateStorageCache(userId) {
  if (userId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(String(userId));
}
