// T5.2: the packaging self-check must actually bite, not just print "ok".
//
// The real repository is checked once; each failure mode is then reproduced in
// a throwaway git repo so a broken rule cannot pass silently.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repo, 'scripts/check-test-assets.mjs');

function result(command, args, cwd) {
  const run = spawnSync(command, args, { cwd, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(run.stdout.trim().split('\n').pop());
  } catch {
    json = null;
  }
  return { status: run.status, json, text: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function sandbox(t, { ignoreRule = true, dockerfile = 'cp -a skills package.json "$stage/"' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'test-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await mkdir(path.join(dir, 'packaging'), { recursive: true });
  await copyFile(script, path.join(dir, 'scripts/check-test-assets.mjs'));
  const rule = ignoreRule ? 'tests/skill-e2e/local-fixtures/\n' : '';
  await writeFile(path.join(dir, '.gitignore'), `node_modules/\n${rule}`);
  await writeFile(path.join(dir, '.dockerignore'), `node_modules/\n${rule}`);
  await writeFile(
    path.join(dir, 'packaging/offline-arm64.Dockerfile'),
    `FROM node:22 AS build\nRUN ${dockerfile}\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  return dir;
}

function check(dir) {
  const run = spawnSync(process.execPath, [path.join(dir, 'scripts/check-test-assets.mjs')], {
    cwd: dir, encoding: 'utf8',
  });
  let json = null;
  try {
    json = JSON.parse(run.stdout.trim().split('\n').pop());
  } catch {
    json = null;
  }
  return { status: run.status, json, text: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

test('the real repository passes the packaging self-check', () => {
  const run = result(process.execPath, [script], repo);
  assert.equal(run.status, 0, run.text);
  assert.equal(run.json?.status, 'ok', run.text);
  assert.equal(run.json?.errors, 0, run.text);
});

test('a clean sandbox passes', async (t) => {
  const dir = await sandbox(t);
  const run = check(dir);
  assert.equal(run.status, 0, run.text);
  assert.equal(run.json?.errors, 0, run.text);
});

test('a tracked local fixture fails the check', async (t) => {
  const dir = await sandbox(t);
  const fixtures = path.join(dir, 'tests/skill-e2e/local-fixtures');
  await mkdir(fixtures, { recursive: true });
  await writeFile(path.join(fixtures, 'sample.png'), 'not really a png');
  execFileSync('git', ['add', '-f', 'tests/skill-e2e/local-fixtures/sample.png'], { cwd: dir, env: GIT_ENV });
  const run = check(dir);
  assert.equal(run.status, 1, run.text);
  assert.match(run.text, /tracked local-only fixtures/u);
});

test('a missing ignore rule fails the check', async (t) => {
  const dir = await sandbox(t, { ignoreRule: false });
  const run = check(dir);
  assert.equal(run.status, 1, run.text);
  assert.match(run.text, /does not exclude tests\/skill-e2e\/local-fixtures/u);
});

test('staging the test tree into the package fails the check', async (t) => {
  const dir = await sandbox(t, { dockerfile: 'cp -a scripts skills tests package.json "$stage/"' });
  const run = check(dir);
  assert.equal(run.status, 1, run.text);
  assert.match(run.text, /copies tests\/ into the offline package/u);
});
