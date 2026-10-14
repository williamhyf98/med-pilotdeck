// ui/server/database/db.multiuser.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-db-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.stubEnv('DATABASE_PATH', '');
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function loadDb() {
  const mod = await import('./db.js');
  await mod.initializeDatabase();
  return mod;
}

describe('multi-user schema', () => {
  it('puts auth.db under <root>/system by default', async () => {
    await loadDb();
    expect(fs.existsSync(path.join(root, 'system', 'auth.db'))).toBe(true);
  });

  it('creates users with role and token_version', async () => {
    const { userDb } = await loadDb();
    const created = userDb.createUser('alice', 'hash', 'user');
    expect(created).toMatchObject({ username: 'alice', role: 'user' });
    const row = userDb.getUserById(created.id);
    expect(row).toMatchObject({ role: 'user', token_version: 0, is_active: 1 });
  });

  it('getAdminUser returns only active admins', async () => {
    const { userDb } = await loadDb();
    expect(userDb.getAdminUser()).toBeUndefined();
    const admin = userDb.createUser('admin', 'hash', 'admin');
    expect(userDb.getAdminUser()?.id).toBe(admin.id);
    userDb.setActive(admin.id, false);
    expect(userDb.getAdminUser()).toBeUndefined();
    expect(userDb.countActiveAdmins()).toBe(0);
  });

  it('bumpTokenVersion increments and returns the new value', async () => {
    const { userDb } = await loadDb();
    const u = userDb.createUser('bob', 'hash');
    expect(userDb.bumpTokenVersion(u.id)).toBe(1);
    expect(userDb.bumpTokenVersion(u.id)).toBe(2);
    expect(userDb.getUserById(u.id).token_version).toBe(2);
  });

  it('system_settings defaults public registration to true', async () => {
    const { systemSettingsDb } = await loadDb();
    expect(systemSettingsDb.isPublicRegistrationAllowed()).toBe(true);
    systemSettingsDb.set('allow_public_registration', 'false');
    expect(systemSettingsDb.isPublicRegistrationAllowed()).toBe(false);
  });

  it('session_names carries user_id and is unique per user', async () => {
    const { db } = await loadDb();
    const cols = db.prepare('PRAGMA table_info(session_names)').all().map((c) => c.name);
    expect(cols).toContain('user_id');
    db.prepare('INSERT INTO session_names (user_id, session_id, provider, custom_name) VALUES (1, \'s1\', \'pilotdeck\', \'A\')').run();
    db.prepare('INSERT INTO session_names (user_id, session_id, provider, custom_name) VALUES (2, \'s1\', \'pilotdeck\', \'B\')').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_names').get().n).toBe(2);
  });
});

describe('legacy upgrade path', () => {
  it('migrates an old-schema <root>/auth.db into system/auth.db', async () => {
    const legacy = new Database(path.join(root, 'auth.db'));
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        is_active BOOLEAN DEFAULT 1,
        git_name TEXT,
        git_email TEXT,
        has_completed_onboarding BOOLEAN DEFAULT 0
      );
      CREATE TABLE session_names (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, provider)
      );
      CREATE INDEX idx_session_names_lookup ON session_names(session_id, provider);
      INSERT INTO users (username, password_hash) VALUES ('old', 'h');
      INSERT INTO session_names (session_id, provider, custom_name) VALUES ('legacy-s1', 'claude', 'Legacy Name');
    `);
    legacy.close();

    const { userDb, sessionNamesDb, initializeDatabase, db } = await loadDb();

    expect(fs.existsSync(path.join(root, 'system', 'auth.db'))).toBe(true);
    expect(userDb.getUserById(1)).toMatchObject({ username: 'old', role: 'user', token_version: 0 });
    expect(sessionNamesDb.getName(0, 'legacy-s1', 'claude')).toBe('Legacy Name');
    expect(sessionNamesDb.getName(1, 'legacy-s1', 'claude')).toBeNull();
    const cols = db.prepare('PRAGMA table_info(session_names)').all().map((c) => c.name);
    expect(cols).toContain('user_id');

    // Second run is idempotent and leaves data intact
    await expect(initializeDatabase()).resolves.not.toThrow();
    expect(userDb.getUserById(1)).toMatchObject({ role: 'user', token_version: 0 });
    expect(sessionNamesDb.getName(0, 'legacy-s1', 'claude')).toBe('Legacy Name');
  });
});
