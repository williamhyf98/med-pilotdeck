import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = new URL('./migrate-user-storage.mjs', import.meta.url).pathname;
// path -> size/mtime, so a content-less touch is detected too
const snapshotTree = (dir, rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
  const p = join(rel, e.name);
  return e.isDirectory() ? [`${p}/`, ...snapshotTree(dir, p)] : [`${p}:${statSync(join(dir, p)).size}:${statSync(join(dir, p)).mtimeMs}`];
}).sort();
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', PILOTDECK_DISABLE_LOCAL_AUTH: '0', PILOTDECK_ADMIN_PASSWORD: 'x', ...env } });

test('dry-run prints the plan and changes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  mkdirSync(join(root, 'projects/general_med/p1'), { recursive: true }); writeFileSync(join(root, 'projects/general_med/p1/meta.json'), '{}');
  const before = snapshotTree(root);
  const r = run(['--pilot-home', root, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshotTree(root), before);
  const report = JSON.parse(r.stdout);
  assert.equal(report.dryRun, true);
  assert.ok(report.plan.some((s) => s.name === 'projects' && s.action === 'move'));
  assert.ok(existsSync(join(root, 'projects/general_med/p1/meta.json')));
  assert.ok(!existsSync(join(root, 'system/migration/legacy-done.json')));
  rmSync(root, { recursive: true, force: true });
});

test('dry-run on a fresh root writes nothing, not even system/', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  mkdirSync(join(root, 'memory/global'), { recursive: true }); writeFileSync(join(root, 'memory/global/a.md'), 'x');
  const before = snapshotTree(root);
  const r = run(['--pilot-home', root, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.adminWillBeCreated, true);
  assert.ok(report.plan.some((s) => s.name === 'memory' && s.action === 'move' && s.to.endsWith('users/1/memory')));
  assert.deepEqual(snapshotTree(root), before);
  assert.ok(!existsSync(join(root, 'system')));
  // --assign-admin has no database to look in
  const missing = run(['--pilot-home', root, '--assign-admin', 'doc1', '--dry-run']);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).error, /no such user: doc1/);
  assert.deepEqual(snapshotTree(root), before);
  rmSync(root, { recursive: true, force: true });
});

test('dry-run against an existing database leaves every file untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  assert.equal(run(['--pilot-home', root, '--seed-user-for-test', 'doc1']).status, 0);
  mkdirSync(join(root, 'projects/p1'), { recursive: true }); writeFileSync(join(root, 'projects/p1/m.json'), '{}');
  const before = snapshotTree(root);
  const authBefore = readFileSync(join(root, 'system/auth.db'));
  const r = run(['--pilot-home', root, '--assign-admin', 'doc1', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.promoted, 'doc1');
  assert.ok(report.plan.some((s) => s.name === 'projects' && s.to.includes('users/')));
  assert.deepEqual(snapshotTree(root), before);
  assert.deepEqual(readFileSync(join(root, 'system/auth.db')), authBefore);
  rmSync(root, { recursive: true, force: true });
});

test('unknown flags and seeding outside NODE_ENV=test yield one JSON error, exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  const bad = run(['--pilot-home', root, '--nope']);
  assert.equal(bad.status, 1);
  assert.ok(JSON.parse(bad.stdout).error);
  const seed = run(['--pilot-home', root, '--seed-user-for-test', 'doc1'], { NODE_ENV: 'production' });
  assert.equal(seed.status, 1);
  assert.match(JSON.parse(seed.stdout).error, /NODE_ENV=test/);
  rmSync(root, { recursive: true, force: true });
});

test('apply migrates and a second run exits 2 (nothing to do)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  mkdirSync(join(root, 'memory/global'), { recursive: true }); writeFileSync(join(root, 'memory/global/a.md'), 'x');
  assert.equal(run(['--pilot-home', root]).status, 0);
  assert.ok(existsSync(join(root, 'users/1/memory/global/a.md')));
  assert.equal(run(['--pilot-home', root]).status, 2);
  rmSync(root, { recursive: true, force: true });
});

test('--assign-admin promotes an existing account when no admin exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  // seed a system db with a non-admin user only
  const seed = run(['--pilot-home', root, '--seed-user-for-test', 'doc1']);
  assert.equal(seed.status, 0, seed.stderr);
  const r = run(['--pilot-home', root, '--assign-admin', 'doc1', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"promoted":\s*"doc1"/);
  rmSync(root, { recursive: true, force: true });
});

test('--assign-admin without --dry-run promotes, and exits 0 even with no legacy data', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  assert.equal(run(['--pilot-home', root, '--seed-user-for-test', 'doc1']).status, 0);
  const r = run(['--pilot-home', root, '--assign-admin', 'doc1']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.promoted, 'doc1');
  assert.equal(report.result, 'nothing-to-do');
  // doc1 is now the active admin: a plain run no longer errors, it just has nothing to do.
  assert.equal(run(['--pilot-home', root]).status, 2);
  rmSync(root, { recursive: true, force: true });
});

test('users without an administrator fail with one JSON report and exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-cli-'));
  assert.equal(run(['--pilot-home', root, '--seed-user-for-test', 'doc1']).status, 0);
  const r = run(['--pilot-home', root]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /no active administrator/);
  const missing = run(['--pilot-home', root, '--assign-admin', 'ghost']);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).error, /no such user: ghost/);
  rmSync(root, { recursive: true, force: true });
});
