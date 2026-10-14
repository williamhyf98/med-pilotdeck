import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; let server; let base;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auth-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.stubEnv('DATABASE_PATH', '');
  vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0');
  vi.stubEnv('PILOTDECK_ADMIN_PASSWORD', 'adminpass');
  vi.resetModules();
  const db = await import('../database/db.js');
  await db.initializeDatabase();
  const { ensureAdminUser } = await import('../services/adminBootstrap.js');
  await ensureAdminUser({ userDb: db.userDb, log: () => {} });
  const { default: authRouter } = await import('./auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (p, body, token) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const get = (p, token) => fetch(`${base}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe('auth routes (multi-user)', () => {
  it('status reports registration open and no setup needed', async () => {
    const body = await (await get('/api/auth/status')).json();
    expect(body).toMatchObject({ needsSetup: false, authDisabled: false, registrationOpen: true });
  });

  it('registers a second user as role=user', async () => {
    const res = await post('/api/auth/register', { username: 'alice', password: 'secret1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ username: 'alice', role: 'user' });
    expect(typeof body.token).toBe('string');
  });

  it.each(['admin', 'Admin', 'ADMIN', ' admin '])('rejects reserved username %s', async (name) => {
    const res = await post('/api/auth/register', { username: name, password: 'secret1' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('RESERVED_USERNAME');
  });

  it('rejects registration when disabled by admin', async () => {
    const { systemSettingsDb } = await import('../database/db.js');
    systemSettingsDb.set('allow_public_registration', 'false');
    const res = await post('/api/auth/register', { username: 'bob', password: 'secret1' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('REGISTRATION_DISABLED');
    expect((await (await get('/api/auth/status')).json()).registrationOpen).toBe(false);
  });

  it('login returns role; logout revokes the token', async () => {
    const login = await (await post('/api/auth/login', { username: 'admin', password: 'adminpass' })).json();
    expect(login.user).toMatchObject({ username: 'admin', role: 'admin' });
    expect((await get('/api/auth/user', login.token)).status).toBe(200);
    expect((await post('/api/auth/logout', {}, login.token)).status).toBe(200);
    const after = await get('/api/auth/user', login.token);
    expect(after.status).toBe(401);
    expect((await after.json()).code).toBe('TOKEN_REVOKED');
  });

  it('password change revokes old token and returns a fresh one', async () => {
    await post('/api/auth/register', { username: 'carol', password: 'oldpass1' });
    const { token } = await (await post('/api/auth/login', { username: 'carol', password: 'oldpass1' })).json();
    const res = await post('/api/auth/password', { currentPassword: 'oldpass1', newPassword: 'newpass2' }, token);
    expect(res.status).toBe(200);
    const { token: fresh } = await res.json();
    expect((await get('/api/auth/user', token)).status).toBe(401);
    expect((await get('/api/auth/user', fresh)).status).toBe(200);
    expect((await post('/api/auth/login', { username: 'carol', password: 'newpass2' })).status).toBe(200);
  });
});
