// ui/server/services/adminBootstrap.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureAdminUser, ADMIN_USERNAME, ADMIN_DEFAULT_PASSWORD } from './adminBootstrap.js';

function fakeUserDb(seed = []) {
  const users = [...seed];
  return {
    users,
    hasUsers: () => users.length > 0,
    getAdminUser: () => users.find((u) => u.role === 'admin' && u.is_active),
    countActiveAdmins: () => users.filter((u) => u.role === 'admin' && u.is_active).length,
    createUser: (username, password_hash, role) => {
      const row = { id: users.length + 1, username, password_hash, role, is_active: 1 };
      users.push(row);
      return { id: row.id, username, role };
    },
  };
}

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-admin-boot-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const adminHomeFile = () => path.join(root, 'system', 'admin-home');

describe('ensureAdminUser', () => {
  it('creates admin with default password when table is empty', async () => {
    const userDb = fakeUserDb();
    const hashed = [];
    const result = await ensureAdminUser({ userDb, env: { PILOT_HOME: root }, bcryptHash: async (p) => { hashed.push(p); return `h:${p}`; }, log: () => {}, ensureHome: () => '/tmp/fake-home' });
    expect(result).toEqual({ created: true, usedDefaultPassword: true });
    expect(userDb.users[0]).toMatchObject({ username: ADMIN_USERNAME, role: 'admin', password_hash: `h:${ADMIN_DEFAULT_PASSWORD}` });
    expect(hashed).toEqual([ADMIN_DEFAULT_PASSWORD]);
  });

  it('uses PILOTDECK_ADMIN_PASSWORD when set', async () => {
    const userDb = fakeUserDb();
    const result = await ensureAdminUser({ userDb, env: { PILOT_HOME: root, PILOTDECK_ADMIN_PASSWORD: 's3cret' }, bcryptHash: async (p) => `h:${p}`, log: () => {}, ensureHome: () => '/tmp/fake-home' });
    expect(result.usedDefaultPassword).toBe(false);
    expect(userDb.users[0].password_hash).toBe('h:s3cret');
  });

  it('never touches an existing admin password', async () => {
    const userDb = fakeUserDb([{ id: 1, username: 'admin', role: 'admin', is_active: 1, password_hash: 'keep' }]);
    const result = await ensureAdminUser({ userDb, env: { PILOT_HOME: root, PILOTDECK_ADMIN_PASSWORD: 'other' }, bcryptHash: async () => { throw new Error('must not hash'); }, log: () => {}, ensureHome: () => '/tmp/fake-home' });
    expect(result).toEqual({ created: false, usedDefaultPassword: false });
    expect(userDb.users[0].password_hash).toBe('keep');
  });

  it('refuses to start when users exist but no active admin', async () => {
    const userDb = fakeUserDb([{ id: 1, username: 'alice', role: 'user', is_active: 1, password_hash: 'x' }]);
    await expect(ensureAdminUser({ userDb, env: {}, bcryptHash: async (p) => p, log: () => {}, ensureHome: () => '/tmp/fake-home' }))
      .rejects.toMatchObject({ code: 'NO_ACTIVE_ADMIN' });
    expect(userDb.users).toHaveLength(1);
  });

  it('points the operator at remediation that actually exists', async () => {
    const userDb = fakeUserDb([{ id: 1, username: 'alice', role: 'user', is_active: 1, password_hash: 'x' }]);
    const error = await ensureAdminUser({ userDb, env: {}, bcryptHash: async (p) => p, log: () => {}, ensureHome: () => '/tmp/fake-home' })
      .then(() => null, (e) => e);
    expect(error.message).toContain('fresh PILOT_HOME');
    expect(error.message).toContain("UPDATE users SET role='admin'");
    // scripts/migrate-user-storage.mjs does not exist; never name it.
    expect(error.message).not.toContain('migrate-user-storage');
  });

  it('writes system/admin-home with the admin home path when it creates the admin', async () => {
    const userDb = fakeUserDb();
    const home = path.join(root, 'users', '1');
    await ensureAdminUser({ userDb, env: { PILOT_HOME: root }, bcryptHash: async (p) => p, log: () => {}, ensureHome: (id) => path.join(root, 'users', String(id)) });
    expect(fs.readFileSync(adminHomeFile(), 'utf8')).toBe(`${home}\n`);
  });

  it('rewrites system/admin-home on every startup, following an admin id change', async () => {
    const userDb = fakeUserDb([{ id: 7, username: 'admin', role: 'admin', is_active: 1, password_hash: 'keep' }]);
    fs.mkdirSync(path.join(root, 'system'), { recursive: true });
    fs.writeFileSync(adminHomeFile(), '/stale/users/1\n');
    await ensureAdminUser({ userDb, env: { PILOT_HOME: root }, bcryptHash: async () => { throw new Error('must not hash'); }, log: () => {}, ensureHome: (id) => path.join(root, 'users', String(id)) });
    expect(fs.readFileSync(adminHomeFile(), 'utf8')).toBe(`${path.join(root, 'users', '7')}\n`);
  });

  it('does not write admin-home when startup is refused', async () => {
    const userDb = fakeUserDb([{ id: 1, username: 'alice', role: 'user', is_active: 1, password_hash: 'x' }]);
    await expect(ensureAdminUser({ userDb, env: { PILOT_HOME: root }, bcryptHash: async (p) => p, log: () => {}, ensureHome: () => '/x' })).rejects.toMatchObject({ code: 'NO_ACTIVE_ADMIN' });
    expect(fs.existsSync(adminHomeFile())).toBe(false);
  });
});
