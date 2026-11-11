// Regression: the macOS dev sandbox denies stat() on `.pilotdeck-home/users`,
// so `fs.realpathSync` on any workspace path fails with EPERM. Spreadsheet
// generation must degrade to a lexical path instead of aborting.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const xlsxScript = path.join(repo, 'skills/spreadsheets/scripts/spreadsheet.sh');

/** Every path containing this segment fails realpath, mirroring the sandbox denial. */
const DENIED_SEGMENT = `${path.sep}users${path.sep}`;

const preload = `
const fs = require('node:fs');
const segment = process.env.PD_DENY_SEGMENT ?? '\\u0000';
const denied = (target) => String(target).includes(segment);
const fail = (target) => {
  const error = new Error("EPERM: operation not permitted, realpath '" + target + "'");
  error.code = 'EPERM';
  throw error;
};
const originalSync = fs.realpathSync;
const patchedSync = function (target, ...rest) {
  if (denied(target)) fail(target);
  return originalSync.call(fs, target, ...rest);
};
patchedSync.native = function (target, ...rest) {
  if (denied(target)) fail(target);
  return originalSync.native(target, ...rest);
};
fs.realpathSync = patchedSync;
const originalPromises = fs.promises.realpath;
fs.promises.realpath = async function (target, ...rest) {
  if (denied(target)) fail(target);
  return originalPromises.call(fs.promises, target, ...rest);
};
`;

function runWithDeniedRealpath(args, env) {
  const result = spawnSync('bash', [xlsxScript, ...args], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: `--require ${env.preloadFile}`, PD_DENY_SEGMENT: DENIED_SEGMENT, ...env },
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const probe = spawnSync('bash', [xlsxScript, 'check'], { cwd: repo, encoding: 'utf8' });
const READY = (() => {
  try {
    const parsed = JSON.parse(probe.stdout);
    return parsed?.status === 'ok' || parsed?.usable === true;
  } catch {
    return false;
  }
})();
const SKIP = READY ? false : 'spreadsheet runtime not installed';

async function sandboxedHome(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pd-realpath-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const home = path.join(data, 'users', '1');
  const work = path.join(home, 'workspaces', 'task', 'work');
  const exports = path.join(home, 'workspaces', 'task', 'exports');
  await mkdir(work, { recursive: true });
  await mkdir(exports, { recursive: true });
  await mkdir(path.join(data, 'users', '2'), { recursive: true });
  const preloadFile = path.join(root, 'deny-realpath.cjs');
  await writeFile(preloadFile, preload, 'utf8');
  return { root, data, home, work, exports, preloadFile };
}

test('generation survives a denied realpath on the workspace ancestors', { skip: SKIP }, async (t) => {
  const env = await sandboxedHome(t);
  const out = path.join(env.exports, 'denied.xlsx');
  const made = runWithDeniedRealpath(
    ['make', '--out', out, '--body', '# 表格\n| 指标 | 值 |\n| --- | --- |\n| 白细胞 | 12.3 |'],
    { preloadFile: env.preloadFile, PILOTDECK_WORK_DIR: env.work },
  );
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json?.status, 'ok', made.text);
  assert.ok(existsSync(out), 'workbook was written');
});

test('the work-dir containment guard still rejects an output inside PILOTDECK_WORK_DIR', { skip: SKIP }, async (t) => {
  const env = await sandboxedHome(t);
  const made = runWithDeniedRealpath(
    ['make', '--out', path.join(env.work, 'bad.xlsx'), '--body', '# x'],
    { preloadFile: env.preloadFile, PILOTDECK_WORK_DIR: env.work },
  );
  assert.notEqual(made.status, 0);
  assert.match(made.text, /must be outside PILOTDECK_WORK_DIR/);
});

test('the denial probe really does block realpath on a workspace path', { skip: SKIP }, async (t) => {
  const env = await sandboxedHome(t);
  const probeFile = path.join(env.root, 'probe.cjs');
  await writeFile(probeFile, `
const fs = require('node:fs');
try {
  fs.realpathSync.native(${JSON.stringify(path.join(env.home, 'workspaces'))});
  console.log('allowed');
} catch (error) {
  console.log(error.code);
}
`, 'utf8');
  const run = spawnSync(process.execPath, ['--require', env.preloadFile, probeFile], {
    encoding: 'utf8',
    env: { ...process.env, PD_DENY_SEGMENT: DENIED_SEGMENT },
  });
  assert.equal(run.stdout.trim(), 'EPERM', run.stderr);
});
