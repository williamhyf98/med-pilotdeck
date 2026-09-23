// @vitest-environment node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root, database, server, homes, request;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-user-safety-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.stubEnv('DATABASE_PATH', path.join(root, 'auth.db'));
  vi.stubEnv('PILOTDECK_CONFIG_PATH', path.join(root, 'pilotdeck.yaml'));
  vi.stubEnv('PILOTDECK_DEPLOY_ENV', path.join(root, 'deploy.env'));
  vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0');
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  vi.stubEnv('PILOTDECK_SETUP_TOKEN', 'test-only-initialization-secret');
  // Precreate to prevent the old importer copying the developer's account DB
  // while this test is being run against the not-yet-hardened merge.
  await fs.writeFile(path.join(root, 'auth.db'), '');
  await fs.writeFile(path.join(root, 'pilotdeck.yaml'), '{}');
  database = await import('../database/db.js');
  await database.initializeDatabase();
  homes = await import('./userHomes.js');
  const { default: authRouter } = await import('../routes/auth.js');
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  request = async (endpoint, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/auth${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
});
afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  homes?.forgetProvisionedHomes();
  database?.db.close();
  vi.resetModules();
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function legacyData() {
  for (const name of ['projects', 'workspaces', 'memory']) {
    await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.writeFile(path.join(root, name, 'private.txt'), `private ${name}`);
  }
}
async function expectLegacyIntact() {
  for (const name of ['projects', 'workspaces', 'memory']) {
    expect(await fs.readFile(path.join(root, name, 'private.txt'), 'utf8')).toBe(`private ${name}`);
  }
  await expect(fs.stat(path.join(root, '.users-migrated-v1'))).rejects.toHaveProperty('code', 'ENOENT');
}
const credentials = { username: 'admin', password: 'test-password-123' };

describe('first-run storage safety', () => {
  it('does not promote an existing ordinary account on restart', async () => {
    const user = database.userDb.createUser('ordinary', 'not-used-in-this-test', 'user');
    await database.initializeDatabase();
    expect(database.userDb.getUserById(user.id).role).toBe('user');
  });
  it('does not copy private global skills into a newly provisioned home', async () => {
    await fs.mkdir(path.join(root, 'skills', 'private-skill'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'private-skill', 'SKILL.md'), 'private knowledge');
    const home = await homes.ensureUserHome(1);
    expect(await fs.readdir(path.join(home, 'skills'))).toEqual([]);
  });

  it('only seeds explicitly enabled published templates, never legacy private skills', async () => {
    await fs.mkdir(path.join(root, 'shared', 'skills', 'public-skill'), { recursive: true });
    await fs.writeFile(path.join(root, 'shared', 'skills', 'public-skill', 'SKILL.md'), 'public knowledge');
    const home = await homes.ensureUserHome(1, { seedSkills: true });
    expect(await fs.readFile(path.join(home, 'skills', 'public-skill', 'SKILL.md'), 'utf8')).toBe('public knowledge');
  });

  it('refuses to start multi-user service over unmigrated legacy data', async () => {
    await legacyData();
    const { runServerStartupBeforeListen } = await import('./server-startup.js');
    await expect(runServerStartupBeforeListen({
      initializeDatabaseFn: database.initializeDatabase,
      ensureLocalUserWhenAuthDisabledFn: async () => {},
      configureWebPushFn: () => {},
      multiUser: true,
    })).rejects.toHaveProperty('code', 'LEGACY_STORAGE_MIGRATION_REQUIRED');
    await expectLegacyIntact();
  });

  it('first registration preserves legacy files and reports migration requirement', async () => {
    await legacyData();
    const result = await request('/register', credentials, { 'X-PilotDeck-Setup-Token': process.env.PILOTDECK_SETUP_TOKEN });
    expect(result.status).toBe(200);
    await expectLegacyIntact();
    const status = await request('/status');
    expect(status.body.storage).toMatchObject({ migrationRequired: true });
    const home = homes.resolveUserHome(result.body.user.id);
    await expect(fs.stat(path.join(home, 'memory', 'private.txt'))).rejects.toHaveProperty('code', 'ENOENT');
  });

  it.each([undefined, 'wrong-token'])('rejects administrator setup without valid initialization credential (%s)', async (token) => {
    const response = await request('/register', credentials, token ? { 'X-PilotDeck-Setup-Token': token } : {});
    expect(response.status).toBe(403);
    expect(database.userDb.hasRealUsers()).toBe(false);
  });

  it('fails closed when the operator has not configured initialization', async () => {
    vi.stubEnv('PILOTDECK_SETUP_TOKEN', '');
    expect((await request('/register', credentials)).status).toBe(503);
    expect(database.userDb.hasRealUsers()).toBe(false);
  });

  it('accepts setup exactly once even with concurrent requests', async () => {
    const headers = { 'X-PilotDeck-Setup-Token': process.env.PILOTDECK_SETUP_TOKEN };
    const results = await Promise.all([
      request('/register', credentials, headers),
      request('/register', { ...credentials, username: 'second' }, headers),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(database.userDb.listUsers()).toHaveLength(1);
  });

  it('rejects administrator HTTP and WebSocket scope impersonation', async () => {
    const result = await request('/register', credentials, { 'X-PilotDeck-Setup-Token': process.env.PILOTDECK_SETUP_TOKEN });
    const other = database.userDb.createUser('other', 'not-used-in-this-test', 'user');
    const response = await request('/user', undefined, {
      Authorization: `Bearer ${result.body.token}`,
      'X-PilotDeck-User-Scope': String(other.id),
    });
    expect(response.status).toBe(403);
    const { buildUserScopeFor } = await import('../middleware/userScope.js');
    await expect(buildUserScopeFor(result.body.user, String(other.id))).rejects.toHaveProperty('code', 'USER_SCOPE_OVERRIDE_DISABLED');
  });
});
