// ui/server/routes/adminUsers.test.js
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; let server; let base; let adminToken; let userToken; let revoked;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-admin-'));
  vi.stubEnv('PILOT_HOME', root); vi.stubEnv('DATABASE_PATH', ''); vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0');
  vi.stubEnv('PILOTDECK_ADMIN_PASSWORD', 'adminpass');
  vi.resetModules();
  const db = await import('../database/db.js'); await db.initializeDatabase();
  const { ensureAdminUser } = await import('../services/adminBootstrap.js');
  await ensureAdminUser({ userDb: db.userDb, log: () => {} });
  const { generateToken, authenticateToken } = await import('../middleware/auth.js');
  const { requireAdmin } = await import('../middleware/requireAdmin.js');
  const { createAdminUsersRouter } = await import('./adminUsers.js');
  revoked = [];
  const app = express(); app.use(express.json());
  app.use('/api/admin', authenticateToken, requireAdmin, createAdminUsersRouter({ onUserRevoked: (id) => revoked.push(id) }));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
  adminToken = generateToken(db.userDb.getAdminUser());
  const alice = db.userDb.createUser('alice', 'x', 'user');
  userToken = generateToken(db.userDb.getUserById(alice.id));
});
afterEach(async () => { await new Promise((r) => server.close(r)); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

const call = (method, p, body, token) => fetch(`${base}${p}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: body ? JSON.stringify(body) : undefined,
});

describe('admin users API', () => {
  it('blocks non-admins', async () => {
    expect((await call('GET', '/api/admin/users', null, userToken)).status).toBe(403);
  });
  it('lists users without password hashes', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    expect(users.map((u) => u.username)).toEqual(['admin', 'alice']);
    expect(users[0]).not.toHaveProperty('password_hash');
  });
  it('creates a user, refusing the reserved name', async () => {
    expect((await call('POST', '/api/admin/users', { username: 'Admin', password: 'secret1' }, adminToken)).status).toBe(403);
    const res = await call('POST', '/api/admin/users', { username: 'bob', password: 'secret1', role: 'admin' }, adminToken);
    expect(res.status).toBe(201);
    expect((await res.json()).user).toMatchObject({ username: 'bob', role: 'admin' });
  });
  it('deactivating a user revokes tokens and notifies', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    const res = await call('PATCH', `/api/admin/users/${alice.id}`, { isActive: false }, adminToken);
    expect(res.status).toBe(200);
    expect(revoked).toEqual([alice.id]);
    expect((await call('GET', '/api/admin/users', null, userToken)).status).toBe(401);
  });
  it('protects the last admin', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const admin = users.find((u) => u.username === 'admin');
    const demote = await call('PATCH', `/api/admin/users/${admin.id}`, { role: 'user' }, adminToken);
    expect(demote.status).toBe(409);
    expect((await demote.json()).code).toBe('LAST_ADMIN');
    const disable = await call('PATCH', `/api/admin/users/${admin.id}`, { isActive: false }, adminToken);
    expect(disable.status).toBe(409);
  });
  it('resets a password and returns it once', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    const { password } = await (await call('POST', `/api/admin/users/${alice.id}/reset-password`, null, adminToken)).json();
    expect(password).toHaveLength(12);
    expect(revoked).toEqual([alice.id]);
  });
  it('toggles registration', async () => {
    expect((await (await call('GET', '/api/admin/settings/registration', null, adminToken)).json()).allowPublicRegistration).toBe(true);
    await call('PUT', '/api/admin/settings/registration', { allowPublicRegistration: false }, adminToken);
    expect((await (await call('GET', '/api/admin/settings/registration', null, adminToken)).json()).allowPublicRegistration).toBe(false);
  });
});
