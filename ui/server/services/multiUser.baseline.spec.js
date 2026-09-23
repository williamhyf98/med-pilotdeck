// @vitest-environment node
import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { makeSecurityFixture } from '../../../tests/security/fixtures.ts';
import { listWebProjects } from '../../../src/web/server/listProjects.ts';
import { listProjectSessions } from '../../../src/session/index.ts';

it('logs in two accounts and routes their project operations to separate reusable runtimes', async () => {
  const f = await makeSecurityFixture();
  let database, pool, server, homes;
  try {
    vi.stubEnv('PILOT_HOME', f.root);
    vi.stubEnv('DATABASE_PATH', path.join(f.root, 'auth.db'));
    vi.stubEnv('PILOTDECK_CONFIG_PATH', path.join(f.root, 'pilotdeck.yaml'));
    vi.stubEnv('PILOTDECK_DEPLOY_ENV', path.join(f.root, 'deploy.env'));
    vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0');
    vi.stubEnv('VITE_IS_PLATFORM', 'false');
    vi.stubEnv('PILOTDECK_SETUP_TOKEN', 'temporary-setup-secret');
    await fs.writeFile(path.join(f.root, 'pilotdeck.yaml'), '{}');
    database = await import('../database/db.js');
    await database.initializeDatabase();
    homes = await import('./userHomes.js');
    const { default: authRouter } = await import('../routes/auth.js');
    const { default: adminRouter } = await import('../routes/adminUsers.js');
    const { authenticateToken, requireAdmin } = await import('../middleware/auth.js');
    const { createSystemProject, getProjects } = await import('../projects.js');
    const { runWithUserScope } = await import('../utils/userScope.js');
    pool = await import('./gatewayPool.js');
    const starts = [];
    pool.__setRuntimeFactoryForTests(async (userId, pilotHome) => {
      starts.push({ userId, pilotHome });
      return {
        // Only process/transport is replaced: use the real disk project
        // reader so a wrong home exposes the wrong fixture and fails.
        gateway: {
          listProjects: () => listWebProjects({ pilotHome }),
          listSessions: async ({ projectKey, limit }) => ({
            sessions: await listProjectSessions({ projectRoot: projectKey, pilotHome, limit }),
          }),
        },
        proc: { pid: userId, kill: () => true }, port: 20000 + userId,
      };
    });
    const app = express();
    app.use(express.json());
    app.use('/auth', authRouter);
    app.use('/admin/users', authenticateToken, requireAdmin, adminRouter);
    // Match the production auth + project service composition, without
    // importing index.js (which starts plugins/watchers and listens).
    app.get('/projects', authenticateToken, async (_req, res, next) => {
      try { res.json(await getProjects()); } catch (error) { next(error); }
    });
    app.post('/projects', authenticateToken, async (req, res, next) => {
      try { res.json(await createSystemProject(req.body)); } catch (error) { next(error); }
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const request = async (endpoint, body, token, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const registered = await request('/auth/register', { username: 'alice', password: 'test-password-123' }, null,
      { 'X-PilotDeck-Setup-Token': 'temporary-setup-secret' });
    const created = await request('/admin/users', { username: 'bob', password: 'test-password-456' }, registered.token);
    expect(created.user.id).toBe(f.scopeB.userId);
    const alice = await request('/auth/login', { username: 'alice', password: 'test-password-123' });
    const bob = await request('/auth/login', { username: 'bob', password: 'test-password-456' });
    for (const [account, scope] of [[alice, f.scopeA], [bob, f.scopeB]]) {
      const listed = await request('/projects', null, account.token);
      expect(listed).toHaveLength(2);
      expect(listed.every((p) => p.fullPath.startsWith(scope.pilotHome + path.sep))).toBe(true);
      const project = await request('/projects', { displayName: `${scope.username}新项目`, type: 'war_trauma' }, account.token);
      expect(project.fullPath.startsWith(scope.pilotHome + path.sep)).toBe(true);
      const refreshed = await request('/projects', null, account.token);
      expect(refreshed).toHaveLength(3);
      const history = await listProjectSessions({
        projectRoot: path.join(scope.pilotHome, 'workspaces/trauma_med/trauma_med-shared'),
        pilotHome: scope.pilotHome,
      });
      expect(history[0].summary).toBe(`${scope.username}的历史病例`);
      await request('/auth/logout', {}, account.token);
    }
    const [a1, a2, b] = await Promise.all([
      runWithUserScope(f.scopeA, () => pool.acquireGateway()),
      runWithUserScope(f.scopeA, () => pool.acquireGateway()),
      runWithUserScope(f.scopeB, () => pool.acquireGateway()),
    ]);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(starts).toEqual([
      { userId: 1, pilotHome: f.scopeA.pilotHome },
      { userId: 2, pilotHome: f.scopeB.pilotHome },
    ]);
    // Logout revocation, new model turns, pool capacity and adversarial
    // cross-user authorization are deliberately NOT claimed by this baseline.
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    pool?.shutdownGatewayPool();
    pool?.__setRuntimeFactoryForTests(null);
    homes?.forgetProvisionedHomes();
    database?.db.close();
    vi.resetModules();
    vi.unstubAllEnvs();
    await f.dispose();
  }
});
