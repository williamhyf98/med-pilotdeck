// ui/server/middleware/auth.multiuser.test.js
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.unstubAllEnvs(); });

const users = new Map();
function seed(user) { users.set(user.id, user); return user; }
function mockDb() {
  vi.doMock('../database/db.js', () => ({
    userDb: {
      getUserById: (id) => users.get(Number(id)),
      getAdminUser: () => [...users.values()].find((u) => u.role === 'admin' && u.is_active === 1),
    },
    appConfigDb: { getOrCreateJwtSecret: () => 'test-secret' },
  }));
}
function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
async function load(authDisabled) {
  vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', authDisabled ? '1' : '0');
  mockDb();
  return import('./auth.js');
}

describe('authenticateToken (multi-user)', () => {
  it('embeds role and tokenVersion and accepts a current token', async () => {
    users.clear();
    const u = seed({ id: 1, username: 'alice', role: 'user', token_version: 2, is_active: 1 });
    const { generateToken, authenticateToken } = await load(false);
    const req = { headers: { authorization: `Bearer ${generateToken(u)}` }, query: {} };
    const res = mockRes();
    const next = vi.fn();
    await authenticateToken(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ id: 1, role: 'user', token_version: 2 });
  });

  it('rejects a token whose version is stale', async () => {
    users.clear();
    const u = seed({ id: 1, username: 'alice', role: 'user', token_version: 0, is_active: 1 });
    const { generateToken, authenticateToken } = await load(false);
    const token = generateToken(u);
    u.token_version = 1;
    const res = mockRes();
    await authenticateToken({ headers: { authorization: `Bearer ${token}` }, query: {} }, res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
  });

  it('rejects a disabled user', async () => {
    users.clear();
    const u = seed({ id: 1, username: 'alice', role: 'user', token_version: 0, is_active: 0 });
    const { generateToken, authenticateToken } = await load(false);
    const res = mockRes();
    await authenticateToken({ headers: { authorization: `Bearer ${generateToken(u)}` }, query: {} }, res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('USER_DISABLED');
  });

  it('no-login mode resolves to the admin user, not the first user', async () => {
    users.clear();
    seed({ id: 1, username: 'alice', role: 'user', token_version: 0, is_active: 1 });
    seed({ id: 2, username: 'admin', role: 'admin', token_version: 0, is_active: 1 });
    const { authenticateToken, authenticateWebSocket } = await load(true);
    const req = { headers: {}, query: {} };
    await authenticateToken(req, mockRes(), vi.fn());
    expect(req.user.id).toBe(2);
    expect(authenticateWebSocket(null)).toMatchObject({ userId: 2, role: 'admin' });
  });

  it('authenticateWebSocket enforces version and active flag', async () => {
    users.clear();
    const u = seed({ id: 1, username: 'alice', role: 'user', token_version: 0, is_active: 1 });
    const { generateToken, authenticateWebSocket } = await load(false);
    const token = generateToken(u);
    expect(authenticateWebSocket(token)).toMatchObject({ userId: 1, role: 'user' });
    u.token_version = 5;
    expect(authenticateWebSocket(token)).toBeNull();
  });
});

describe('requireAdmin', () => {
  it('passes admins and blocks users', async () => {
    const { requireAdmin } = await import('./requireAdmin.js');
    const next = vi.fn();
    requireAdmin({ user: { role: 'admin' } }, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    const res = mockRes();
    requireAdmin({ user: { role: 'user' } }, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
