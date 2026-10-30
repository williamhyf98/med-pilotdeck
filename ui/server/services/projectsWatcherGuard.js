// ui/server/services/projectsWatcherGuard.js
// The projects watcher reacts to filesystem events under <root>/users/<id>/.
// When an administrator deletes an account, its home is *renamed* into
// archives/users/, which emits a burst of unlink events for that user. Running
// the scoped refresh for them would list projects through the Gateway pool,
// spawning a fresh Gateway for the deleted user and recreating its home
// skeleton. Only live accounts with an existing home are refreshed.
import fs from 'node:fs';
import { resolveUserHome } from '../utils/pilotPaths.js';

export function canRefreshProjectsFor(userId, { userDb, env = process.env } = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (!fs.existsSync(resolveUserHome(id, env))) return false;
  const user = userDb?.getUserById?.(id);
  return Boolean(user) && Number(user.is_active) === 1;
}
