// @vitest-environment node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

it('single-operator bypass retains management access without promoting the persisted account', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-auth-bypass-'));
  let database;
  try {
    vi.stubEnv('PILOT_HOME', root);
    vi.stubEnv('DATABASE_PATH', path.join(root, 'auth.db'));
    vi.stubEnv('PILOTDECK_CONFIG_PATH', path.join(root, 'pilotdeck.yaml'));
    vi.stubEnv('PILOTDECK_DEPLOY_ENV', path.join(root, 'deploy.env'));
    vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '1');
    vi.stubEnv('VITE_IS_PLATFORM', 'false');
    await fs.writeFile(path.join(root, 'pilotdeck.yaml'), '{}');
    database = await import('../database/db.js');
    await database.initializeDatabase();
    const user = database.userDb.createUser('existing', 'unused', 'user');
    const { authenticateToken, authenticateWebSocket, requireAdmin } = await import('./auth.js');
    const req = {};
    const res = { status() { throw new Error('bypass unexpectedly rejected'); } };
    let reached = false;
    await authenticateToken(req, res, () => requireAdmin(req, res, () => { reached = true; }));
    expect(reached).toBe(true);
    expect(authenticateWebSocket(null).role).toBe('admin');
    expect(database.userDb.getUserById(user.id).role).toBe('user');
  } finally {
    database?.db.close();
    vi.resetModules();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
