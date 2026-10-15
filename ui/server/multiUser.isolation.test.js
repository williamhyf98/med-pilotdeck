// @vitest-environment node
// ui/server/multiUser.isolation.test.js
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; let server; let base; let tokens; let pool;
const fakeGateway = (userId) => ({
  userId,
  listProjects: async () => ({ projects: [] }),
  listSessions: async () => ({ sessions: [] }),
  describeProject: async () => null,
  skillsList: async () => ({ builtin: [], user: [{ name: `skill-of-${userId}` }], project: [], medical: [] }),
  abortTurn: async () => {},
  close: () => {},
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-'));
  vi.stubEnv('PILOT_HOME', root); vi.stubEnv('DATABASE_PATH', ''); vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0');
  vi.stubEnv('PILOTDECK_ADMIN_PASSWORD', 'adminpass');
  vi.resetModules();
  pool = { acquire: vi.fn(async (id) => ({ gateway: fakeGateway(String(id)), runtimeId: `${id}:1`, release: () => {} })), markRevoked: vi.fn(), shutdown: vi.fn(async () => {}), snapshot: () => [] };
  vi.doMock('./services/gatewayPool.js', () => ({ createGatewayPool: () => pool }));

  const db = await import('./database/db.js'); await db.initializeDatabase();
  const { ensureAdminUser } = await import('./services/adminBootstrap.js');
  await ensureAdminUser({ userDb: db.userDb, log: () => {} });
  const { authenticateToken, generateToken } = await import('./middleware/auth.js');
  const { userScopeMiddleware, runWithUserScope } = await import('./middleware/userScope.js');
  const { requireAdmin } = await import('./middleware/requireAdmin.js');
  const { default: authRouter } = await import('./routes/auth.js');
  const { createAdminUsersRouter } = await import('./routes/adminUsers.js');
  const { default: skillsRouter } = await import('./routes/skills.js');
  const { default: memoryRouter } = await import('./routes/memory.js');
  const { default: storageRouter } = await import('./routes/storage.js');
  const projects = await import('./projects.js');

  const app = express(); app.use(express.json());
  const requireUser = [authenticateToken, userScopeMiddleware];
  app.use('/api/auth', authRouter);
  app.use('/api/admin', authenticateToken, userScopeMiddleware, requireAdmin, createAdminUsersRouter({ onUserRevoked: (id) => pool.markRevoked(id) }));
  app.use('/api/skills', ...requireUser, skillsRouter);
  app.use('/api/memory', ...requireUser, memoryRouter);
  app.use('/api/storage', ...requireUser, storageRouter);
  app.get('/api/projects', ...requireUser, async (_req, res) => res.json({ projects: await projects.getProjects() }));
  app.post('/api/projects/create-system', ...requireUser, async (req, res) => res.json(await projects.createSystemProject(req.body)));
  app.get('/api/projects/:id/sessions', ...requireUser, async (req, res) => {
    try { res.json(await projects.getSessions(req.params.id)); } catch (e) { res.status(e.status ?? 404).json({ error: e.message }); }
  });
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;

  const alice = db.userDb.createUser('alice', 'x', 'user'); const bob = db.userDb.createUser('bob', 'x', 'user');
  tokens = { admin: generateToken(db.userDb.getAdminUser()), alice: generateToken(db.userDb.getUserById(alice.id)), bob: generateToken(db.userDb.getUserById(bob.id)) };
  tokens.ids = { alice: alice.id, bob: bob.id };
});
afterEach(async () => { await new Promise((r) => server.close(r)); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

const api = (who, method, p, body) => fetch(`${base}${p}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body ? JSON.stringify(body) : undefined,
});

describe('A/B isolation', () => {
  it('projects: A sees only A, directories differ, B cannot read A\'s files by id', async () => {
    const a = await (await api('alice', 'POST', '/api/projects/create-system', { displayName: '同名病例', type: 'general_medicine' })).json();
    const b = await (await api('bob', 'POST', '/api/projects/create-system', { displayName: '同名病例', type: 'general_medicine' })).json();
    // project ids may legitimately collide across users; only the directories must differ
    const aDir = path.join(root, 'users', String(tokens.ids.alice), 'projects', 'general_med', a.name);
    const bDir = path.join(root, 'users', String(tokens.ids.bob), 'projects', 'general_med', b.name);
    expect(fs.existsSync(path.join(aDir, 'meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(bDir, 'meta.json'))).toBe(true);
    expect(aDir).not.toBe(bDir);
    expect(fs.existsSync(path.join(root, 'projects'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'users', String(tokens.ids.alice), 'projects', 'general_med'))).toEqual([a.name]);

    // alice-only second project: bob has no project of that id at all
    const a2 = await (await api('alice', 'POST', '/api/projects/create-system', { displayName: '仅Alice', type: 'general_medicine' })).json();
    expect(fs.existsSync(path.join(root, 'users', String(tokens.ids.bob), 'projects', 'general_med', a2.name))).toBe(false);
    const listA = await (await api('alice', 'GET', '/api/projects')).json();
    const listB = await (await api('bob', 'GET', '/api/projects')).json();
    expect(listA.projects.map((p) => p.displayName).sort()).toEqual(['仅Alice', '同名病例']);
    expect(listB.projects.map((p) => p.displayName)).toEqual(['同名病例']);

    // file-level cross read through /api/storage/preview
    const wsDir = path.join(root, 'users', String(tokens.ids.alice), 'workspaces', 'general_med', a2.name);
    fs.mkdirSync(path.join(wsDir, 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'inbox', 'secret.txt'), 'alice secret');
    const q = `scope=workspace&groupId=${encodeURIComponent(a2.name)}&typeKey=general_med&path=inbox/secret.txt`;
    const own = await api('alice', 'GET', `/api/storage/preview?${q}`);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('alice secret');
    const cross = await api('bob', 'GET', `/api/storage/preview?${q}`);
    expect(cross.status).toBe(404);
  });

  it('storage: each caller scans only their own workspaces', async () => {
    const a = await (await api('alice', 'POST', '/api/projects/create-system', { displayName: '仅Alice', type: 'general_medicine' })).json();
    const scanA = await (await api('alice', 'GET', '/api/storage')).json();
    const scanB = await (await api('bob', 'GET', '/api/storage')).json();
    expect(scanA.workspaces.map((w) => w.id)).toContain(a.name);
    expect(JSON.stringify(scanB)).not.toContain(a.name);
  });

  it('skills: the list is served by the caller\'s own gateway lease', async () => {
    const forA = await (await api('alice', 'POST', '/api/skills/list', {})).json();
    const forB = await (await api('bob', 'POST', '/api/skills/list', {})).json();
    expect(forA.user).toEqual([{ name: `skill-of-${tokens.ids.alice}` }]);
    expect(forB.user).toEqual([{ name: `skill-of-${tokens.ids.bob}` }]);
  });

  it('memory: identity data dirs live under each caller\'s own home, even for colliding project ids', async () => {
    const a = await (await api('alice', 'POST', '/api/projects/create-system', { displayName: '同名病例', type: 'general_medicine' })).json();
    const b = await (await api('bob', 'POST', '/api/projects/create-system', { displayName: '同名病例', type: 'general_medicine' })).json();
    const resA = await api('alice', 'GET', `/api/memory/identity?projectName=${encodeURIComponent(a.name)}`);
    const resB = await api('bob', 'GET', `/api/memory/identity?projectName=${encodeURIComponent(b.name)}`);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const idA = await resA.json();
    const idB = await resB.json();
    const homeA = path.join(root, 'users', String(tokens.ids.alice)) + path.sep;
    const homeB = path.join(root, 'users', String(tokens.ids.bob)) + path.sep;
    expect(idA.dataDir.startsWith(homeA)).toBe(true);
    expect(idB.dataDir.startsWith(homeB)).toBe(true);
    expect(idA.dataDir).not.toBe(idB.dataDir);
  });

  it('gateway pool is asked for the caller\'s id, never someone else\'s', async () => {
    await api('alice', 'GET', '/api/projects');
    await api('bob', 'GET', '/api/projects');
    expect(pool.acquire.mock.calls.map((c) => String(c[0])).sort()).toEqual([String(tokens.ids.alice), String(tokens.ids.bob)].sort());
  });

  it('admin cannot list another user\'s projects through any mounted route', async () => {
    await api('alice', 'POST', '/api/projects/create-system', { displayName: 'private', type: 'general_medicine' });
    const adminList = await (await api('admin', 'GET', '/api/projects')).json();
    expect(adminList.projects).toHaveLength(0);
  });

  it('deactivating B revokes B and recycles B\'s gateway', async () => {
    const res = await api('admin', 'PATCH', `/api/admin/users/${tokens.ids.bob}`, { isActive: false });
    expect(res.status).toBe(200);
    expect(pool.markRevoked).toHaveBeenCalledWith(tokens.ids.bob);
    expect((await api('bob', 'GET', '/api/projects')).status).toBe(401);
  });

  it('each WebSocket keeps the scope bound at handshake even when another user connects later', async () => {
    // Mirrors index.js handleChatConnection: the handler closure is created inside runWithUserScope once per connection.
    const { runWithUserScope, requireUserScope } = await import('./middleware/userScope.js');
    const makeHandler = (scope) => (message) => runWithUserScope(scope, async () => `${requireUserScope().userId}:${message}`);
    const handlerA = makeHandler({ userId: tokens.ids.alice, role: 'user' });
    const handlerB = makeHandler({ userId: tokens.ids.bob, role: 'user' });
    const [a, b, a2] = await Promise.all([handlerA('m1'), handlerB('m2'), handlerA('m3')]);
    expect(a).toBe(`${tokens.ids.alice}:m1`);
    expect(b).toBe(`${tokens.ids.bob}:m2`);
    expect(a2).toBe(`${tokens.ids.alice}:m3`);
  });

  it('a request without scope is a 500, not a fallback to the root', async () => {
    const bare = express(); bare.use(express.json());
    const projects = await import('./projects.js');
    bare.get('/x', async (_req, res) => { try { res.json(await projects.getProjects()); } catch (e) { res.status(500).json({ code: e.code }); } });
    const s = bare.listen(0);
    const r = await fetch(`http://127.0.0.1:${s.address().port}/x`);
    await new Promise((d) => s.close(d));
    expect(r.status).toBe(500);
    expect((await r.json()).code).toBe('USER_SCOPE_MISSING');
    expect(fs.existsSync(path.join(root, 'projects'))).toBe(false);
  });
});

describe('Plan 2 regressions', () => {
  it('legacy data migrated at boot lands in admin\'s home only', async () => {
    // Fresh root seeded with the single-user layout BEFORE the database opens,
    // then the real startup order: initializeDatabase -> ensureAdminUser -> migrateLegacyStorage.
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-legacy-'));
    let legacyServer;
    try {
      const { seedLegacyRoot } = await import('./testUtils/legacyRoot.js');
      seedLegacyRoot(legacyRoot);
      // the first boot pinned DATABASE_PATH to its own root; clear it so system/auth.db follows the new PILOT_HOME
      vi.stubEnv('PILOT_HOME', legacyRoot); vi.stubEnv('DATABASE_PATH', '');
      vi.resetModules();
      vi.doMock('./services/gatewayPool.js', () => ({ createGatewayPool: () => pool }));
      const db = await import('./database/db.js'); await db.initializeDatabase();
      const { ensureAdminUser } = await import('./services/adminBootstrap.js');
      await ensureAdminUser({ userDb: db.userDb, log: () => {} });
      const { migrateLegacyStorage } = await import('./services/legacyMigration.js');
      const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
      expect(result.skipped).toBeFalsy();

      const { authenticateToken, generateToken } = await import('./middleware/auth.js');
      const { userScopeMiddleware } = await import('./middleware/userScope.js');
      const projects = await import('./projects.js');
      const app = express(); app.use(express.json());
      app.get('/api/projects', authenticateToken, userScopeMiddleware, async (_req, res) => res.json({ projects: await projects.getProjects() }));
      legacyServer = app.listen(0);
      const url = `http://127.0.0.1:${legacyServer.address().port}/api/projects`;
      const admin = db.userDb.getAdminUser();
      const alice = db.userDb.createUser('alice', 'x', 'user');
      const list = async (user) => (await (await fetch(url, { headers: { Authorization: `Bearer ${generateToken(user)}` } })).json()).projects;

      const adminNames = (await list(admin)).map((p) => p.name);
      expect(adminNames).toContain('general_med-aaa');
      expect(adminNames).toContain('trauma_med-bbb');
      expect(await list(db.userDb.getUserById(alice.id))).toEqual([]);

      expect(fs.existsSync(path.join(legacyRoot, 'projects'))).toBe(false);
      expect(fs.existsSync(path.join(legacyRoot, 'users', String(admin.id), 'projects', 'general_med', 'general_med-aaa', 'meta.json'))).toBe(true);
      expect(fs.existsSync(path.join(legacyRoot, 'users', String(alice.id), 'projects', 'general_med', 'general_med-aaa'))).toBe(false);
      expect(fs.existsSync(path.join(legacyRoot, 'system', 'migration', 'legacy-done.json'))).toBe(true);
    } finally {
      if (legacyServer) await new Promise((r) => legacyServer.close(r));
      fs.rmSync(legacyRoot, { recursive: true, force: true });
    }
  });

  it('revoked user loses chat and shell sockets', async () => {
    const { SOCKET_USER_ID, closeUserSockets } = await import('./services/wsScope.js');
    const fakeSocket = (userId) => ({ [SOCKET_USER_ID]: String(userId), readyState: 1, close: vi.fn() });
    const aliceChat = fakeSocket(tokens.ids.alice);
    const aliceShell = fakeSocket(tokens.ids.alice);
    const bobChat = fakeSocket(tokens.ids.bob);
    const connectedClients = new Set([aliceChat, bobChat]);
    const auxClients = new Set([aliceShell]);

    // revokeUserRuntime sweeps both sets, as index.js does
    closeUserSockets(connectedClients, tokens.ids.alice, { code: 4401, reason: 'TOKEN_REVOKED' });
    closeUserSockets(auxClients, tokens.ids.alice, { code: 4401, reason: 'TOKEN_REVOKED' });

    expect(aliceChat.close).toHaveBeenCalledWith(4401, 'TOKEN_REVOKED');
    expect(aliceShell.close).toHaveBeenCalledWith(4401, 'TOKEN_REVOKED');
    expect(bobChat.close).not.toHaveBeenCalled();
  });

  it('normal user cannot reach system config even through the settings page endpoints', async () => {
    const { authenticateToken } = await import('./middleware/auth.js');
    const { userScopeMiddleware } = await import('./middleware/userScope.js');
    const { requireAdmin } = await import('./middleware/requireAdmin.js');
    const { buildApiRouter } = await import('./apiRouter.js');
    const inline = Object.fromEntries(['agentsRuntimeConfig', 'ccrDashboard', 'ccrHealth', 'ccrConfig', 'ccrStatsSummary', 'ccrSessionStats',
      'ccrStatsReset', 'ccrConfigPut', 'browseFilesystem', 'createFolder', 'createProjectManual'].map((key) => [key, (_req, res) => res.json({})]));
    const app = express(); app.use(express.json());
    app.use('/api', buildApiRouter({ authenticateToken, userScopeMiddleware, requireAdmin, inline }));
    const gated = app.listen(0);
    try {
      const gbase = `http://127.0.0.1:${gated.address().port}`;
      const call = (who, method, p) => fetch(`${gbase}${p}`, {
        method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}',
      });
      for (const [method, p] of [['GET', '/api/config'], ['GET', '/api/memory/settings'], ['PUT', '/api/plugins/med-tools/enable']]) {
        const u = await call('alice', method, p);
        expect(`${method} ${p} -> ${u.status}`).toBe(`${method} ${p} -> 403`);
        expect((await u.json()).code).toBe('ADMIN_REQUIRED');
        expect((await call('admin', method, p)).status).not.toBe(403);
      }
    } finally {
      await new Promise((r) => gated.close(r));
    }
  });
});
