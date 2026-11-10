import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = path.join(repo, 'skills/frontend-slides/scripts/html.sh');
const themesCss = path.join(repo, 'skills/frontend-slides/assets/themes/pd-themes.css');
const fixtures = path.join(repo, 'tests/skills/fixtures/html');

function run(args, options = {}) {
  return spawnSync('bash', [wrapper, ...args], { encoding: 'utf8', ...options });
}

function json(args) {
  const result = run(args);
  assert.ok(result.stdout, result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout) };
}

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'html-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'exports/assets'), { recursive: true });
  return dir;
}

async function writeSample(ws, name = '示例报告') {
  const template = await readFile(path.join(fixtures, 'themed.template.html'), 'utf8');
  const css = await readFile(themesCss, 'utf8');
  const file = path.join(ws, 'exports', `${name}.html`);
  await writeFile(file, template.replace('/*__PD_THEMES__*/', css));
  await cp(path.join(fixtures, 'assets/photo.png'), path.join(ws, 'exports/assets/photo.png'));
  return file;
}

test('check reports the Python backend', () => {
  const { status, data } = json(['check']);
  assert.equal(status, 0);
  assert.equal(data.audit, true);
  assert.equal(data.package, true);
});

test('package builds a dated folder with hashed assets and a clean audit', async (t) => {
  const ws = await workspace(t);
  const html = await writeSample(ws);
  const { status, data } = json(['package', '--html', html, '--workspace', ws, '--timezone', 'Asia/Shanghai']);
  assert.equal(status, 0, JSON.stringify(data));
  assert.equal(data.status, 'ok');
  assert.match(path.basename(data.output), /^示例报告_\d{8}-\d{4}$/);
  const files = (await readdir(path.join(data.output, 'assets'))).sort();
  assert.deepEqual(files, ['photo-c414cd0e.png']);
  const index = await readFile(path.join(data.output, 'index.html'), 'utf8');
  assert.match(index, /src="assets\/photo-c414cd0e\.png"/);
  assert.doesNotMatch(index, /src="assets\/photo\.png"/);
  for (const phase of ['scan', 'collect', 'copy', 'write', 'zip', 'total']) {
    assert.equal(typeof data.timing_ms[phase], 'number');
  }

  const audited = json(['audit', data.output]);
  assert.equal(audited.data.status, 'ok', JSON.stringify(audited.data.issues));
});

test('two runs produce byte-identical index.html and a collision suffix', async (t) => {
  const ws = await workspace(t);
  const html = await writeSample(ws);
  const first = json(['package', '--html', html, '--workspace', ws]).data;
  const second = json(['package', '--html', html, '--workspace', ws]).data;
  assert.notEqual(first.output, second.output);
  assert.match(path.basename(second.output), /-2$/);
  assert.equal(
    await readFile(first.index, 'utf8'),
    await readFile(second.index, 'utf8'),
  );
});

test('missing images become an explicit placeholder and are reported', async (t) => {
  const ws = await workspace(t);
  const html = path.join(ws, 'exports/缺图.html');
  await writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>缺图</title></head><body><h1>缺图</h1>
<img src="assets/missing.png" alt="示意图"><p>正文</p></body></html>`);
  const { status, data } = json(['package', '--html', html, '--workspace', ws]);
  assert.equal(status, 0);
  assert.equal(data.status, 'delivered_with_missing_assets');
  assert.equal(data.missing[0].replaced, true);
  const index = await readFile(data.index, 'utf8');
  assert.match(index, /图片未提供（原文件：assets\/missing\.png）/);
  assert.equal(json(['audit', data.output]).data.status, 'ok');
});

test('unportable references block packaging', async (t) => {
  const ws = await workspace(t);
  const external = path.join(ws, 'exports/外链.html');
  await cp(path.join(fixtures, 'bad-external.html'), external);
  const blocked = json(['package', '--html', external, '--workspace', ws]).data;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'unportable-reference');

  const outside = path.join(ws, 'exports/越界.html');
  await cp(path.join(fixtures, 'outside.html'), outside);
  const escaped = json(['package', '--html', outside, '--workspace', ws]).data;
  assert.equal(escaped.status, 'blocked');

  const unsafe = path.join(ws, 'exports/不安全.html');
  await cp(path.join(fixtures, 'unsafe.html'), unsafe);
  const blockedUnsafe = json(['package', '--html', unsafe, '--workspace', ws]).data;
  assert.equal(blockedUnsafe.status, 'blocked');
  assert.ok(blockedUnsafe.references.some((item) => item.kind === 'javascript'));
  assert.ok(blockedUnsafe.references.some((item) => item.kind === 'unsafe-data'));
});

test('--update replaces index.html but never deletes user files', async (t) => {
  const ws = await workspace(t);
  const html = await writeSample(ws);
  const first = json(['package', '--html', html, '--workspace', ws]).data;
  await writeFile(path.join(first.output, 'notes.txt'), 'keep-me');
  await writeFile(html, (await readFile(html, 'utf8')).replace('示例报告', '示例报告（更新）'));
  const updated = json(['package', '--html', html, '--workspace', ws,
    '--out-dir', first.output, '--update']).data;
  assert.equal(updated.status, 'ok');
  assert.match(await readFile(updated.index, 'utf8'), /示例报告（更新）/);
  assert.equal(await readFile(path.join(first.output, 'notes.txt'), 'utf8'), 'keep-me');
});

test('output must stay inside the workspace and never overwrite the source directory', async (t) => {
  const ws = await workspace(t);
  const html = await writeSample(ws);
  const outside = json(['package', '--html', html, '--workspace', ws,
    '--out-dir', path.join(os.tmpdir(), 'not-this-workspace')]).data;
  assert.equal(outside.status, 'blocked');
  assert.equal(outside.code, 'output-outside-workspace');
});

test('srcset entries are copied and rewritten with the same hashed asset', async (t) => {
  const ws = await workspace(t);
  const html = path.join(ws, 'exports/srcset.html');
  await cp(path.join(fixtures, 'assets/photo.png'), path.join(ws, 'exports/assets/photo.png'));
  await writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>srcset</title></head><body><h1>srcset</h1>
<img src="assets/photo.png" srcset="assets/photo.png 1x" alt="图"></body></html>`);
  const { data } = json(['package', '--html', html, '--workspace', ws]);
  const index = await readFile(data.index, 'utf8');
  assert.match(index, /src="assets\/photo-c414cd0e\.png"/);
  assert.match(index, /srcset="assets\/photo-c414cd0e\.png 1x"/);
  assert.equal(json(['audit', data.output]).data.status, 'ok');
});

test('package writes a deterministic zip that verify accepts', async (t) => {
  const ws = await workspace(t);
  const html = await writeSample(ws);
  const first = json(['package', '--html', html, '--workspace', ws]).data;
  const second = json(['package', '--html', html, '--workspace', ws]).data;
  assert.ok(first.zip && second.zip);
  assert.equal(first.zip_sha256, second.zip_sha256);
  assert.equal(await readFile(first.zip, 'base64'), await readFile(second.zip, 'base64'));

  const verified = json(['verify', first.output]);
  assert.equal(verified.data.status, 'ok', JSON.stringify(verified.data.issues));
  assert.equal(verified.data.zip_entries, 2);
  assert.equal(verified.data.audit_status, 'ok');
  assert.equal(verified.data.visual_acceptance, 'not_performed');
});

test('verify catches a missing asset and a tampered zip entry', async (t) => {
  const ws = await workspace(t);
  const html = await writeSample(ws);
  const packed = json(['package', '--html', html, '--workspace', ws]).data;

  const broken = `${packed.output}-broken`;
  await cp(packed.output, broken, { recursive: true });
  await rm(path.join(broken, 'assets/photo-c414cd0e.png'));
  const missing = json(['verify', broken]).data;
  assert.equal(missing.status, 'failed');
  assert.ok(missing.issues.some((item) => item.code === 'missing-resource'));

  const tampered = `${packed.output}-tampered`;
  await cp(packed.output, tampered, { recursive: true });
  await cp(packed.zip, `${tampered}.zip`);
  await writeFile(path.join(tampered, 'assets/photo-c414cd0e.png'), Buffer.from('not a png'));
  const mismatch = json(['verify', tampered]).data;
  assert.equal(mismatch.status, 'failed');
  assert.ok(mismatch.issues.some((item) => item.code === 'zip-entry-mismatch'));
});

test('--no-zip leaves a folder-only delivery that verify reports as a warning', async (t) => {
  const ws = await workspace(t);
  const html = await writeSample(ws);
  const packed = json(['package', '--html', html, '--workspace', ws, '--no-zip']).data;
  assert.equal(packed.zip, null);
  const verified = json(['verify', packed.output]).data;
  assert.equal(verified.status, 'warning');
  assert.ok(verified.issues.some((item) => item.code === 'zip-missing'));
});
