// ui/server/services/adminBootstrap.test.js
import { describe, expect, it } from 'vitest';
import { ensureAdminUser, ADMIN_USERNAME, ADMIN_DEFAULT_PASSWORD } from './adminBootstrap.js';

function fakeUserDb(seed = []) {
  const users = [...seed];
  return {
    users,
    hasUsers: () => users.length > 0,
    countActiveAdmins: () => users.filter((u) => u.role === 'admin' && u.is_active).length,
    createUser: (username, password_hash, role) => {
      const row = { id: users.length + 1, username, password_hash, role, is_active: 1 };
      users.push(row);
      return { id: row.id, username, role };
    },
  };
}

describe('ensureAdminUser', () => {
  it('creates admin with default password when table is empty', async () => {
    const userDb = fakeUserDb();
    const hashed = [];
    const result = await ensureAdminUser({ userDb, env: {}, bcryptHash: async (p) => { hashed.push(p); return `h:${p}`; }, log: () => {}, ensureHome: () => {} });
    expect(result).toEqual({ created: true, usedDefaultPassword: true });
    expect(userDb.users[0]).toMatchObject({ username: ADMIN_USERNAME, role: 'admin', password_hash: `h:${ADMIN_DEFAULT_PASSWORD}` });
    expect(hashed).toEqual([ADMIN_DEFAULT_PASSWORD]);
  });

  it('uses PILOTDECK_ADMIN_PASSWORD when set', async () => {
    const userDb = fakeUserDb();
    const result = await ensureAdminUser({ userDb, env: { PILOTDECK_ADMIN_PASSWORD: 's3cret' }, bcryptHash: async (p) => `h:${p}`, log: () => {}, ensureHome: () => {} });
    expect(result.usedDefaultPassword).toBe(false);
    expect(userDb.users[0].password_hash).toBe('h:s3cret');
  });

  it('never touches an existing admin password', async () => {
    const userDb = fakeUserDb([{ id: 1, username: 'admin', role: 'admin', is_active: 1, password_hash: 'keep' }]);
    const result = await ensureAdminUser({ userDb, env: { PILOTDECK_ADMIN_PASSWORD: 'other' }, bcryptHash: async () => { throw new Error('must not hash'); }, log: () => {}, ensureHome: () => {} });
    expect(result).toEqual({ created: false, usedDefaultPassword: false });
    expect(userDb.users[0].password_hash).toBe('keep');
  });

  it('refuses to start when users exist but no active admin', async () => {
    const userDb = fakeUserDb([{ id: 1, username: 'alice', role: 'user', is_active: 1, password_hash: 'x' }]);
    await expect(ensureAdminUser({ userDb, env: {}, bcryptHash: async (p) => p, log: () => {}, ensureHome: () => {} }))
      .rejects.toMatchObject({ code: 'NO_ACTIVE_ADMIN' });
    expect(userDb.users).toHaveLength(1);
  });

  it('points the operator at remediation that actually exists', async () => {
    const userDb = fakeUserDb([{ id: 1, username: 'alice', role: 'user', is_active: 1, password_hash: 'x' }]);
    const error = await ensureAdminUser({ userDb, env: {}, bcryptHash: async (p) => p, log: () => {}, ensureHome: () => {} })
      .then(() => null, (e) => e);
    expect(error.message).toContain('fresh PILOT_HOME');
    expect(error.message).toContain("UPDATE users SET role='admin'");
    // scripts/migrate-user-storage.mjs does not exist; never name it.
    expect(error.message).not.toContain('migrate-user-storage');
  });
});
