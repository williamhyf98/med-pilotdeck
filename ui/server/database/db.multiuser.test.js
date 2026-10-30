// ui/server/database/db.multiuser.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
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

const LEGACY_SCHEMA_SQL = `
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
`;

function writeLegacyDb(file) {
  const legacy = new Database(file);
  legacy.exec(LEGACY_SCHEMA_SQL);
  legacy.close();
}

describe('legacy upgrade path', () => {
  // DATABASE_PATH points straight at an old-schema file (that is how an
  // operator opens a pre-multi-user database): runMigrations must upgrade it
  // in place without losing rows.
  it('migrates an old-schema database the operator points DATABASE_PATH at', async () => {
    const legacyPath = path.join(root, 'legacy-auth.db');
    writeLegacyDb(legacyPath);
    vi.stubEnv('DATABASE_PATH', legacyPath);

    const { userDb, sessionNamesDb, initializeDatabase, db } = await loadDb();

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

  // Plan 1 ruling: the legacy single-user database at <root>/auth.db is left
  // alone. Moving that data across is the next plan's explicit migration.
  it('leaves a pre-existing <root>/auth.db byte-for-byte untouched', async () => {
    const rootDbPath = path.join(root, 'auth.db');
    writeLegacyDb(rootDbPath);
    const before = createHash('sha256').update(fs.readFileSync(rootDbPath)).digest('hex');
    const beforeStat = fs.statSync(rootDbPath);

    const { userDb } = await loadDb();

    expect(fs.existsSync(path.join(root, 'system', 'auth.db'))).toBe(true);
    const after = createHash('sha256').update(fs.readFileSync(rootDbPath)).digest('hex');
    expect(after).toBe(before);
    expect(fs.statSync(rootDbPath).size).toBe(beforeStat.size);
    // No sidecar journals were created next to the legacy file either.
    expect(fs.existsSync(`${rootDbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${rootDbPath}-shm`)).toBe(false);
    // The fresh system database does not carry the legacy account over.
    expect(userDb.getUserByUsername('old')).toBeUndefined();
    expect(userDb.hasUsers()).toBe(false);
  });
});
