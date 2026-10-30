// ui/server/routes/adminUsers.test.js
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; let server; let base; let adminToken; let userToken; let revoked; let stopped;
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
  revoked = []; stopped = [];
  const app = express(); app.use(express.json());
  app.use('/api/admin', authenticateToken, requireAdmin, createAdminUsersRouter({
    onUserRevoked: (id) => revoked.push(id),
    stopUserRuntime: async (id) => { await new Promise((r) => setTimeout(r, 10)); stopped.push({ id, at: Date.now() }); },
  }));
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
  it('rejects a duplicate username with 409 USERNAME_TAKEN', async () => {
    const res = await call('POST', '/api/admin/users', { username: 'alice', password: 'secret1' }, adminToken);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('USERNAME_TAKEN');
  });
  it('blocks non-admins from writes too', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    expect((await call('POST', '/api/admin/users', { username: 'eve', password: 'secret1' }, userToken)).status).toBe(403);
    expect((await call('PATCH', `/api/admin/users/${alice.id}`, { role: 'admin' }, userToken)).status).toBe(403);
  });
  it('deactivating a user revokes tokens and notifies', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    const res = await call('PATCH', `/api/admin/users/${alice.id}`, { isActive: false }, adminToken);
    expect(res.status).toBe(200);
    expect(revoked).toEqual([alice.id]);
    expect((await call('GET', '/api/admin/users', null, userToken)).status).toBe(401);
  });
  it('is a no-op when the patch changes nothing: no token bump, no revoke', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    const res = await call('PATCH', `/api/admin/users/${alice.id}`, { role: 'user', isActive: true }, adminToken);
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ id: alice.id, role: 'user', isActive: true });
    expect(revoked).toEqual([]);
    // the untouched session still works
    expect((await call('GET', '/api/admin/users', null, userToken)).status).toBe(403);
  });

  it('still applies (and revokes) when only one of the two fields changes', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    const res = await call('PATCH', `/api/admin/users/${alice.id}`, { role: 'admin', isActive: true }, adminToken);
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ role: 'admin' });
    expect(revoked).toEqual([alice.id]);
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
  it('DELETE deactivates, revokes, archives the home and refuses the last admin', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    fs.mkdirSync(path.join(root, 'users', String(alice.id), 'projects'), { recursive: true });
    fs.writeFileSync(path.join(root, 'users', String(alice.id), 'projects', 'note.txt'), 'hello');
    const res = await call('DELETE', `/api/admin/users/${alice.id}`, null, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(true);
    expect(body.user).toMatchObject({ id: alice.id, isActive: false });
    expect(revoked).toContain(alice.id);
    expect(fs.existsSync(path.join(root, 'users', String(alice.id)))).toBe(false);
    const archived = fs.readdirSync(path.join(root, 'archives', 'users'));
    expect(archived.some((n) => n.startsWith(`${alice.id}-`))).toBe(true);
    // The archive keeps the data: this is a soft delete.
    expect(fs.readFileSync(path.join(root, 'archives', 'users', archived[0], 'projects', 'note.txt'), 'utf8')).toBe('hello');
    const admin = users.find((u) => u.username === 'admin');
    const refused = await call('DELETE', `/api/admin/users/${admin.id}`, null, adminToken);
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('LAST_ADMIN');
  });

  it('DELETE waits for the user Gateway to stop before moving the home away', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    fs.mkdirSync(path.join(root, 'users', String(alice.id)), { recursive: true });
    const res = await call('DELETE', `/api/admin/users/${alice.id}`, null, adminToken);
    expect(res.status).toBe(200);
    expect(stopped.map((s) => s.id)).toEqual([alice.id]);
    const archived = fs.readdirSync(path.join(root, 'archives', 'users'));
    expect(archived).toHaveLength(1);
    // the rename only happened once the pool had reported the child gone
    expect(fs.statSync(path.join(root, 'archives', 'users', archived[0])).mtimeMs)
      .toBeGreaterThanOrEqual(stopped[0].at - 1000);
    expect(fs.existsSync(path.join(root, 'users', String(alice.id)))).toBe(false);
  });

  it('DELETE on an unknown user is 404 and never touches the filesystem', async () => {
    const res = await call('DELETE', '/api/admin/users/9999', null, adminToken);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('USER_NOT_FOUND');
    expect(fs.existsSync(path.join(root, 'archives', 'users'))).toBe(false);
  });

  it('DELETE is refused for non-admins', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    expect((await call('DELETE', `/api/admin/users/${alice.id}`, null, userToken)).status).toBe(403);
  });

  it('list carries storageBytes', async () => {
    const { users } = await (await call('GET', '/api/admin/users', null, adminToken)).json();
    const alice = users.find((u) => u.username === 'alice');
    expect(users.every((u) => typeof u.storageBytes === 'number')).toBe(true);
    expect(alice.storageBytes).toBe(0);
  });

  it('toggles registration', async () => {
    expect((await (await call('GET', '/api/admin/settings/registration', null, adminToken)).json()).allowPublicRegistration).toBe(true);
    await call('PUT', '/api/admin/settings/registration', { allowPublicRegistration: false }, adminToken);
    expect((await (await call('GET', '/api/admin/settings/registration', null, adminToken)).json()).allowPublicRegistration).toBe(false);
  });
});
