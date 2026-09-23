// @vitest-environment node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';

it('opening a fresh DATABASE_PATH never inherits the installation account database', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-db-import-safety-'));
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  try {
    // Execute the real importer beside a synthetic legacy database. No real
    // account DB is opened or touched, including during the red phase.
    await fs.copyFile(path.join(sourceDir, 'db.js'), path.join(root, 'db.mjs'));
    await fs.copyFile(path.join(sourceDir, 'init.sql'), path.join(root, 'init.sql'));
    await fs.symlink(path.resolve(sourceDir, '../../node_modules'), path.join(root, 'node_modules'), 'dir');
    const legacy = new Database(path.join(root, 'auth.db'));
    legacy.exec('CREATE TABLE private_legacy_marker (secret TEXT); INSERT INTO private_legacy_marker VALUES (\'legacy-only\')');
    legacy.close();
    const target = path.join(root, 'fresh', 'auth.db');
    await promisify(execFile)(process.execPath, [path.join(root, 'db.mjs')], {
      env: { ...process.env, DATABASE_PATH: target, PILOT_HOME: root },
    });
    const fresh = new Database(target);
    try {
      expect(fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'private_legacy_marker'").all()).toEqual([]);
    } finally { fresh.close(); }
    const original = new Database(path.join(root, 'auth.db'));
    try {
      expect(original.prepare('SELECT secret FROM private_legacy_marker').get().secret).toBe('legacy-only');
    } finally { original.close(); }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
