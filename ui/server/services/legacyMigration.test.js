// @vitest-environment node
// ui/server/services/legacyMigration.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectId } from '../utils/pilotPaths.js';
import { seedLegacyRoot as seed } from '../testUtils/legacyRoot.js';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mig-'));
  vi.stubEnv('PILOT_HOME', root); vi.stubEnv('DATABASE_PATH', '');
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

const seedLegacyRoot = () => seed(root);

// Every regular file under `dir`, as `relative path -> contents`. `skip` names
// top-level entries the migration never snapshots (keep/system/snapshot set).
function fileMap(dir, skip = [], rel = '') {
  const out = {};
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel ? path.join(rel, entry.name) : entry.name;
    if (!rel && skip.includes(entry.name)) continue;
    if (entry.isDirectory()) Object.assign(out, fileMap(dir, skip, next));
    else if (entry.isFile()) out[next] = fs.readFileSync(path.join(dir, next), 'utf8');
  }
  return out;
}
const SNAPSHOT_SKIP = ['users', 'system', 'archives', 'plugins', 'pilotdeck.yaml', 'pilotdeck.yaml.bak-1'];

async function boot() {
  const db = await import('../database/db.js'); await db.initializeDatabase();
  const { ensureAdminUser } = await import('./adminBootstrap.js');
  await ensureAdminUser({ userDb: db.userDb, log: () => {} });
  const { migrateLegacyStorage } = await import('./legacyMigration.js');
  return { db, migrateLegacyStorage, admin: db.userDb.getAdminUser() };
}

describe('legacy migration', () => {
  it('moves user data into the admin home, archives history, drops noise, keeps system files', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(result.skipped).toBe(false);
    const home = path.join(root, 'users', String(admin.id));
    expect(fs.existsSync(path.join(home, 'projects/general_med/general_med-aaa/meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'workspaces/general_med/general_med-aaa/inbox/a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'memory/global/UserIdentity/profile.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'skills/my-skill/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'logs/trauma-agent.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.pilotdeck/tool-results/t1.json'))).toBe(true);
    // general container renamed to the new home-derived id (Review Focus 1)
    expect(fs.existsSync(path.join(home, 'projects', createProjectId(home), 'chats/web:s_1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'projects', createProjectId(root)))).toBe(false);
    expect(fs.existsSync(path.join(root, 'projects'))).toBe(false);
    for (const gone of ['router', 'telemetry', 'cron', 'server-token', 'workspaces', 'memory', 'skills', 'logs', 'auth.db', 'mystery', 'migration-reports', '.workspace-migration-v1.json', '.pilotdeck']) {
      expect(fs.existsSync(path.join(root, gone))).toBe(false);
    }
    expect(fs.existsSync(path.join(root, 'system/migration/history/legacy-auth.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'system/migration/history/migration-reports/r.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'system/migration/history/unknown/mystery/thing.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'pilotdeck.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'pilotdeck.yaml.bak-1'))).toBe(true);
    const snapshot = fs.readdirSync(path.join(root, 'archives')).find((n) => n.startsWith('legacy-'));
    expect(fs.existsSync(path.join(root, 'archives', snapshot, 'router/events.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'archives', snapshot, 'projects/general_med/general_med-aaa/meta.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'system/migration/legacy-done.json'), 'utf8')).adminId).toBe(admin.id);
    expect(db.sessionNamesDb.getName(admin.id, 'web:s_1', 'pilotdeck')).toBe('旧名字');
  });

  it('merges into an existing admin home and archives conflicting children', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const home = path.join(root, 'users', String(admin.id));
    fs.mkdirSync(path.join(home, 'projects/general_med/general_med-aaa'), { recursive: true });
    fs.writeFileSync(path.join(home, 'projects/general_med/general_med-aaa/meta.json'), 'NEW');
    await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(fs.readFileSync(path.join(home, 'projects/general_med/general_med-aaa/meta.json'), 'utf8')).toBe('NEW');
    expect(fs.existsSync(path.join(root, 'system/migration/history/conflicts/projects/general_med/general_med-aaa/meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'projects/trauma_med/trauma_med-bbb/meta.json'))).toBe(true);
  });

  it('is idempotent and resumable after a partial run (Review Focus 2)', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const home = path.join(root, 'users', String(admin.id));
    // simulate a crash: projects already moved, no marker
    fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
    fs.renameSync(path.join(root, 'projects/general_med'), path.join(home, 'projects/general_med'));
    const first = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(first.skipped).toBe(false);
    expect(fs.existsSync(path.join(home, 'projects/general_med/general_med-aaa/meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'system/migration/history/conflicts/projects/general_med'))).toBe(false);
    expect(first.applied).toContainEqual(expect.objectContaining({ name: 'projects', action: 'move' }));
    expect(first.applied).toContainEqual(expect.objectContaining({ name: `projects/${createProjectId(root)}`, action: 'move' }));
    expect(first.applied).toContainEqual(expect.objectContaining({ name: 'router', action: 'drop' }));
    const second = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(second).toMatchObject({ skipped: true, reason: 'marker-present' });
  });

  it('records skip/already-migrated when a whole top-level entry was moved before the crash', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const home = path.join(root, 'users', String(admin.id));
    fs.rmSync(path.join(home, 'memory'), { recursive: true });
    fs.renameSync(path.join(root, 'memory'), path.join(home, 'memory'));
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(result.applied).toContainEqual(expect.objectContaining({ name: 'memory', action: 'skip', reason: 'already-migrated' }));
    expect(fs.readFileSync(path.join(home, 'memory/global/UserIdentity/profile.md'), 'utf8')).toBe('# me');
    expect(fs.existsSync(path.join(root, 'system/migration/history/conflicts/memory'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'system/migration/legacy-done.json'))).toBe(true);
  });

  it('keeps the home copy and archives the legacy copy when a child exists on both sides after a partial move', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const home = path.join(root, 'users', String(admin.id));
    fs.mkdirSync(path.join(home, 'skills/my-skill'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills/my-skill/SKILL.md'), 'HOME');
    await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(fs.readFileSync(path.join(home, 'skills/my-skill/SKILL.md'), 'utf8')).toBe('HOME');
    expect(fs.readFileSync(path.join(root, 'system/migration/history/conflicts/skills/my-skill/SKILL.md'), 'utf8')).toContain('my-skill');
  });

  it('never follows symlinks while merging: a link is moved intact when free, archived when the name is taken', async () => {
    seedLegacyRoot();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ext-'));
    try {
      fs.writeFileSync(path.join(external, 'keep.txt'), 'EXT');
      fs.symlinkSync(external, path.join(root, 'skills/linked'), 'dir');
      fs.symlinkSync(external, path.join(root, 'skills/free-link'), 'dir');
      const { db, migrateLegacyStorage, admin } = await boot();
      const home = path.join(root, 'users', String(admin.id));
      fs.mkdirSync(path.join(home, 'skills/linked'), { recursive: true });
      await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
      expect(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8')).toBe('EXT');
      expect(fs.readdirSync(external)).toEqual(['keep.txt']);
      expect(fs.lstatSync(path.join(home, 'skills/free-link')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(root, 'system/migration/history/conflicts/skills/linked')).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(path.join(home, 'skills/linked'))).toEqual([]);
      expect(fs.existsSync(path.join(root, 'skills'))).toBe(false);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('fails closed when residue is left behind even though no step threw', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage } = await boot();
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (a, b) => {
      if (String(a).endsWith(path.join('logs', 'trauma-agent.jsonl'))) return undefined; // silently does nothing
      return realRename(a, b);
    });
    await expect(migrateLegacyStorage({ userDb: db.userDb, log: () => {} })).rejects.toMatchObject({ code: 'LEGACY_MIGRATION_FAILED', message: expect.stringContaining('residue') });
    expect(fs.existsSync(path.join(root, 'system/migration/legacy-done.json'))).toBe(false);
  });

  it('wraps planning-phase errors as LEGACY_MIGRATION_FAILED (dangling symlink at root)', async () => {
    const { db, migrateLegacyStorage } = await boot();
    fs.symlinkSync(path.join(root, 'does-not-exist'), path.join(root, 'skills'));
    await expect(migrateLegacyStorage({ userDb: db.userDb, log: () => {} })).rejects.toMatchObject({ code: 'LEGACY_MIGRATION_FAILED' });
    expect(fs.existsSync(path.join(root, 'system/migration/legacy-done.json'))).toBe(false);
  });

  it('does nothing on a fresh root', async () => {
    const { db, migrateLegacyStorage } = await boot();
    expect(await migrateLegacyStorage({ userDb: db.userDb, log: () => {} })).toMatchObject({ skipped: true, reason: 'no-legacy-layout' });
  });

  it('fails closed: a move error leaves no marker and throws LEGACY_MIGRATION_FAILED', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage } = await boot();
    const realRename = fs.promises.rename;
    // The admin skeleton already has memory/, so memory is merged child-by-child: fail on anything under legacy memory/.
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (a, b) => {
      if (/[\\/]memory([\\/]|$)/.test(String(a))) throw new Error('EIO');
      return realRename(a, b);
    });
    await expect(migrateLegacyStorage({ userDb: db.userDb, log: () => {} })).rejects.toMatchObject({ code: 'LEGACY_MIGRATION_FAILED' });
    expect(fs.existsSync(path.join(root, 'system/migration/legacy-done.json'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'archives')).some((n) => n.startsWith('legacy-'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'memory/global/UserIdentity/profile.md'))).toBe(true);
  });

  it('leaves every archives/ child except projects/ in place (spec 9.4)', async () => {
    seedLegacyRoot();
    fs.mkdirSync(path.join(root, 'archives/old-run'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archives/old-run/a.txt'), 'x');
    const { db, migrateLegacyStorage, admin } = await boot();
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    const home = path.join(root, 'users', String(admin.id));
    // only `archives/projects/` is user data; anything else under archives/ is root-owned
    expect(fs.readFileSync(path.join(root, 'archives/old-run/a.txt'), 'utf8')).toBe('x');
    expect(fs.existsSync(path.join(home, 'archives/old-run'))).toBe(false);
    expect(fs.existsSync(result.snapshotDir)).toBe(true);
    expect(fs.existsSync(path.join(home, 'archives', path.basename(result.snapshotDir)))).toBe(false);
  });

  it('moves only archives/projects into the home and never archives the other children as unknown', async () => {
    seedLegacyRoot();
    fs.mkdirSync(path.join(root, 'archives/projects/general_med-aaa-20260101T000000Z'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archives/projects/general_med-aaa-20260101T000000Z/snap.json'), '{}');
    fs.mkdirSync(path.join(root, 'archives/legacy-old'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archives/legacy-old/keep.txt'), 'keep');
    const { db, migrateLegacyStorage, admin } = await boot();
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    const home = path.join(root, 'users', String(admin.id));
    expect(result.applied).toContainEqual(expect.objectContaining({ name: 'archives/projects', action: 'move' }));
    expect(result.applied.some((s) => s.name === 'archives')).toBe(false);
    expect(fs.readFileSync(path.join(home, 'archives/projects/general_med-aaa-20260101T000000Z/snap.json'), 'utf8')).toBe('{}');
    expect(fs.existsSync(path.join(root, 'archives/projects'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'archives/legacy-old/keep.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(root, 'system/migration/history/unknown/archives'))).toBe(false);
    // the snapshot carries the moved archive too
    expect(fs.existsSync(path.join(result.snapshotDir, 'archives/projects/general_med-aaa-20260101T000000Z/snap.json'))).toBe(true);
  });

  it('snapshots every entry even when hardlinking is unsupported (EXDEV)', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage } = await boot();
    const before = fileMap(root, SNAPSHOT_SKIP);
    vi.spyOn(fs.promises, 'link').mockRejectedValue(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(Object.keys(before).length).toBeGreaterThan(5);
    expect(fileMap(result.snapshotDir)).toEqual(before);
  });

  it('hardlinks snapshot files instead of copying their bytes', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage } = await boot();
    const source = path.join(root, 'memory/global/UserIdentity/profile.md');
    try {
      fs.linkSync(source, path.join(root, '.link-probe'));
      fs.rmSync(path.join(root, '.link-probe'));
    } catch {
      return; // this filesystem cannot hardlink; the completeness test above still applies
    }
    const sourceIno = fs.statSync(source).ino;
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    const copied = path.join(result.snapshotDir, 'memory/global/UserIdentity/profile.md');
    expect(fs.existsSync(copied)).toBe(true);
    expect(fs.statSync(copied).ino).toBe(sourceIno);
  });

  it('announces the snapshot before copying and confirms it afterwards', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage } = await boot();
    const lines = [];
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: (m) => lines.push(m) });
    const start = lines.findIndex((l) => /snapshotting \d+ entries into /.test(l));
    const done = lines.findIndex((l) => l.includes('snapshot at '));
    expect(start).toBe(0);
    expect(done).toBe(1);
    expect(lines[0]).toContain(result.snapshotDir);
  });

  it('imports the lone legacy account\'s api keys and credentials onto the admin', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const lines = [];
    await migrateLegacyStorage({ userDb: db.userDb, log: (m) => lines.push(m) });
    const keys = db.apiKeysDb.getApiKeys(admin.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ key_name: 'cli', api_key: 'ck_legacykey', is_active: 1 });
    expect(keys[0].created_at).toBe('2026-01-01 00:00:00');
    const creds = db.credentialsDb.getCredentials(admin.id);
    expect(creds).toHaveLength(1);
    expect(creds[0]).toMatchObject({ credential_name: 'github', credential_type: 'github_token', description: 'old token' });
    expect(db.credentialsDb.getActiveCredential(admin.id, 'github_token')).toBe('ghp_legacy');
    expect(lines.join('\n')).toContain('imported 1 api key(s) and 1 credential(s) from legacy auth.db');
  });

  it('does not duplicate api keys or credentials when a failed run is retried', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    const realRename = fs.promises.rename;
    // First attempt: the account data is imported, then the very first move
    // step (.pilotdeck sorts before auth.db) fails, so the legacy db is still
    // at the root when the operator retries.
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (a, b) => {
      if (/[\\/]\.pilotdeck([\\/]|$)/.test(String(a))) throw new Error('EIO');
      return realRename(a, b);
    });
    await expect(migrateLegacyStorage({ userDb: db.userDb, log: () => {} })).rejects.toMatchObject({ code: 'LEGACY_MIGRATION_FAILED' });
    expect(fs.existsSync(path.join(root, 'auth.db'))).toBe(true); // archive step never ran
    spy.mockRestore();

    const lines = [];
    await migrateLegacyStorage({ userDb: db.userDb, log: (m) => lines.push(m) });
    expect(db.apiKeysDb.getApiKeys(admin.id)).toHaveLength(1);
    expect(db.credentialsDb.getCredentials(admin.id)).toHaveLength(1);
    expect(lines.join('\n')).toContain('imported 0 api key(s) and 0 credential(s) from legacy auth.db');
  });

  it('skips FIFOs and other special files while snapshotting instead of blocking on them', async () => {
    if (process.platform === 'win32') return;
    seedLegacyRoot();
    const { execFileSync } = await import('node:child_process');
    const fifo = path.join(root, '.tmp', 'pipe');
    fs.mkdirSync(path.dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    const { db, migrateLegacyStorage, admin } = await boot();
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(fs.existsSync(path.join(result.snapshotDir, '.tmp', 'pipe'))).toBe(false);
    // the live tree is renamed, not copied, so the FIFO itself travels with .tmp/
    expect(fs.lstatSync(path.join(root, 'users', String(admin.id), '.tmp', 'pipe')).isFIFO()).toBe(true);
  });

  it('ignores dotfiles and plain files under users/ when deciding whether the root is already multi-user', async () => {
    seedLegacyRoot();
    const { db, migrateLegacyStorage, admin } = await boot();
    fs.writeFileSync(path.join(root, 'users', '.DS_Store'), '');
    fs.writeFileSync(path.join(root, 'users', 'notes.txt'), 'x');
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(result.skipped).toBeFalsy();
    expect(fs.existsSync(path.join(root, 'users', String(admin.id), 'memory', 'global', 'UserIdentity', 'profile.md'))).toBe(true);
  });

  it('imports nothing but warns by name when the legacy db held several accounts', async () => {
    seedLegacyRoot();
    const legacy = new Database(path.join(root, 'auth.db'));
    legacy.exec(`INSERT INTO users (username, password_hash) VALUES ('alice', 'h2');
      INSERT INTO api_keys (user_id, key_name, api_key) VALUES (2, 'alice-cli', 'ck_alicekey');
      INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value) VALUES (2, 'gl', 'gitlab_token', 'glpat_alice');`);
    legacy.close();
    const { db, migrateLegacyStorage, admin } = await boot();
    const lines = [];
    await migrateLegacyStorage({ userDb: db.userDb, log: (m) => lines.push(m) });
    expect(db.apiKeysDb.getApiKeys(admin.id)).toEqual([]);
    expect(db.credentialsDb.getCredentials(admin.id)).toEqual([]);
    const warning = lines.filter((l) => /WARNING|local|alice|legacy-auth\.db/.test(l)).join('\n');
    expect(warning).toContain('local');
    expect(warning).toContain('alice');
    expect(warning).toContain('legacy-auth.db');
    // never the secrets themselves
    expect(lines.join('\n')).not.toContain('ck_alicekey');
    expect(lines.join('\n')).not.toContain('glpat_alice');
    expect(lines.join('\n')).not.toContain('h2');
    // session names are still imported: they are not account-scoped secrets
    expect(db.sessionNamesDb.getName(admin.id, 'web:s_1', 'pilotdeck')).toBe('旧名字');
  });

  it('refuses to run on a born-multi-user root: users/ holds another account (spec 9.1)', async () => {
    // a system that was never single-user: the only "legacy" shape left is a stray root dir
    fs.mkdirSync(path.join(root, 'memory/global'), { recursive: true });
    fs.writeFileSync(path.join(root, 'memory/global/a.md'), '# me');
    const archived = path.join(root, 'archives/users/7-2026-01-01T00-00-00-000Z/projects');
    fs.mkdirSync(archived, { recursive: true });
    fs.writeFileSync(path.join(archived, 'x'), 'x');
    const { db, migrateLegacyStorage, admin } = await boot();
    fs.mkdirSync(path.join(root, 'users/7/projects'), { recursive: true });
    const lines = [];
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: (m) => lines.push(m) });
    expect(result).toMatchObject({ skipped: true, reason: 'users-populated' });
    expect(lines).toHaveLength(1);
    // nothing was snapshotted, archived or moved
    expect(fs.readdirSync(path.join(root, 'archives')).some((n) => n.startsWith('legacy-'))).toBe(false);
    expect(fs.readFileSync(path.join(archived, 'x'), 'utf8')).toBe('x');
    expect(fs.readFileSync(path.join(root, 'memory/global/a.md'), 'utf8')).toBe('# me');
    expect(fs.existsSync(path.join(root, 'users', String(admin.id), 'memory/global/a.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'system/migration/legacy-done.json'))).toBe(false);
  });
});
