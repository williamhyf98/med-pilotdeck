// T4.4: diagram-maker design themes are a colour/font axis, separate from the
// `clean` / `architecture` layout axis. Without --design-theme the renderer must
// keep the historical output byte for byte.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadTokens } from '../../skills/_shared/tokens.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repo, 'skills/diagram-maker/scripts/diagram.sh');

function run(args) {
  const result = spawnSync('bash', [script, ...args], { cwd: repo, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'diagram-theme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const BODY = '分诊 → 抢救 → 后送';

test('no design theme keeps the historical palette', async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'plain.svg');
  const made = run(['make', '--title', '救治流程', '--body', BODY, '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.designTheme, undefined, 'no theme claim without --design-theme');
  const svg = await readFile(out, 'utf8');
  assert.ok(svg.includes('fill="#f8fafc"'), 'default paper');
  assert.ok(svg.includes('stroke="#64748b"'), 'default stroke');
  assert.ok(svg.includes('font-family="ui-sans-serif,system-ui,sans-serif"'), 'default font stack');
});

test('a design theme repaints colours and fonts but not geometry', async (t) => {
  const dir = await tempDir(t);
  const { tokens } = await loadTokens();
  const theme = tokens.themes.archive;
  const plain = path.join(dir, 'plain.svg');
  const themed = path.join(dir, 'archive.svg');
  assert.equal(run(['make', '--title', '救治流程', '--body', BODY, '--out', plain]).status, 0);
  const made = run(['make', '--title', '救治流程', '--body', BODY,
    '--design-theme', '宣纸病案', '--out', themed]);
  assert.equal(made.status, 0, made.text);
  assert.deepEqual(made.json.designTheme, { id: 'archive', label: '宣纸病案' });
  assert.equal(made.json.theme, 'clean', 'the layout axis is untouched');

  const svg = await readFile(themed, 'utf8');
  assert.ok(svg.includes(`fill="#${theme.colors.paper}"`), 'page background uses paper');
  assert.ok(svg.includes(`fill="#${theme.colors.primary}"`), 'the title uses primary');
  assert.ok(svg.includes(`stroke="#${theme.colors.muted}"`), 'edges and borders use muted');
  assert.ok(svg.includes('Noto Serif SC'), 'the serif theme swaps the font role');

  const plainSvg = await readFile(plain, 'utf8');
  const geometry = (source) => source.match(/\b(?:width|height|viewBox)="[^"]+"/g)?.join(' ');
  assert.equal(geometry(plainSvg), geometry(svg), 'the canvas size must not change with the palette');
  const boxes = (source) => source.match(/<rect x="[\d.]+" y="[\d.]+"/g)?.join(' ') ?? '';
  assert.equal(boxes(plainSvg), boxes(svg), 'node boxes keep their coordinates');
});

test('layout and palette are independent axes', async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'arch.json');
  await writeFile(spec, JSON.stringify({
    theme: 'architecture',
    title: '系统架构',
    nodes: [
      { id: 'app', label: '应用', kind: 'service' },
      { id: 'db', label: '归档库', kind: 'database' },
      { id: 'pac', label: 'PACS', kind: 'external' },
    ],
    edges: [{ from: 'app', to: 'db' }, { from: 'db', to: 'pac' }],
  }));
  const out = path.join(dir, 'arch.svg');
  const made = run(['make', '--spec', spec, '--design-theme', 'clinical', '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.theme, 'architecture', 'the layout stays architecture');
  assert.equal(made.json.designTheme.id, 'clinical');
  const svg = await readFile(out, 'utf8');
  assert.ok(svg.includes('<ellipse'), 'the database cylinder is drawn by the layout axis');
  assert.ok(svg.includes('stroke-dasharray="6 4"'), 'external nodes stay dashed');
  assert.ok(svg.includes('#12404F'), 'colours come from the clinical palette');
});

test('an unknown theme fails with the list of available names', async (t) => {
  const dir = await tempDir(t);
  const made = run(['make', '--body', BODY, '--design-theme', '不存在的主题',
    '--out', path.join(dir, 'x.svg')]);
  assert.equal(made.status, 2);
  assert.equal(made.json.code, 'invalid-diagram-input');
  for (const label of ['临床晨光', '青黛循证', '宣纸病案']) {
    assert.ok(made.text.includes(label), `the error should list ${label}`);
  }
});

test('spec designTheme works and the CLI flag wins', async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'flow.json');
  await writeFile(spec, JSON.stringify({
    designTheme: 'academic',
    nodes: [{ id: 'a', label: '入院' }, { id: 'b', label: '出院' }],
    edges: [{ from: 'a', to: 'b' }],
  }));
  const fromSpec = path.join(dir, 'spec.svg');
  const specRun = run(['make', '--spec', spec, '--out', fromSpec]);
  assert.equal(specRun.status, 0, specRun.text);
  assert.equal(specRun.json.designTheme.id, 'academic');

  const fromCli = path.join(dir, 'cli.svg');
  const cliRun = run(['make', '--spec', spec, '--design-theme', 'trauma', '--out', fromCli]);
  assert.equal(cliRun.status, 0, cliRun.text);
  assert.equal(cliRun.json.designTheme.id, 'trauma', 'the CLI flag overrides the spec');
});

test('audit accepts a design theme and still reports geometry', async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'flow.svg');
  const report = path.join(dir, 'audit.json');
  assert.equal(run(['make', '--body', BODY, '--design-theme', 'edu',
    '--out', out]).status, 0);
  const audited = run(['audit', '--input', out, '--design-theme', 'edu', '--report', report]);
  assert.equal(audited.status, 0, audited.text);
  const payload = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(payload.counts.errors, 0);
  assert.ok(payload.viewBox.width > 0);
});
