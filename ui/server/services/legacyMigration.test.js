// @vitest-environment node
// ui/server/services/legacyMigration.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    const second = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    expect(second).toMatchObject({ skipped: true, reason: 'marker-present' });
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

  it('keeps the snapshot when the legacy root has its own archives/ directory', async () => {
    seedLegacyRoot();
    fs.mkdirSync(path.join(root, 'archives/old-run'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archives/old-run/a.txt'), 'x');
    const { db, migrateLegacyStorage, admin } = await boot();
    const result = await migrateLegacyStorage({ userDb: db.userDb, log: () => {} });
    const home = path.join(root, 'users', String(admin.id));
    expect(fs.existsSync(path.join(home, 'archives/old-run/a.txt'))).toBe(true);
    expect(fs.existsSync(result.snapshotDir)).toBe(true);
    expect(fs.existsSync(path.join(home, 'archives', path.basename(result.snapshotDir)))).toBe(false);
  });
});
