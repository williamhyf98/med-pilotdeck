// Geometry fixes for diagram-maker:
//   1. a decision rhombus grows until its label fits inside the slanted edges,
//   2. an edge label never sits on the connector's middle segment,
//   3. an over-wide plain chain rotates to TB unless a direction was asked for.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'diagram-layout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Mirrors diagram_cli.text_width: CJK glyphs count one unit, ASCII 0.55.
function textWidth(text) {
  return [...text].reduce((total, char) => total + (char.codePointAt(0) > 127 ? 1 : 0.55), 0);
}

function canvas(svg) {
  const match = svg.match(/width="(\d+)" height="(\d+)"/);
  return { width: Number(match[1]), height: Number(match[2]) };
}

// The rhombus path is M cx top L right cy L cx bottom L left cy Z.
function rhombus(svg) {
  const match = svg.match(
    /<path d="M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) L [\d.]+ [\d.]+ L ([\d.]+) [\d.]+ Z"/);
  assert.ok(match, 'the decision rhombus is missing');
  const top = Number(match[2]);
  const right = Number(match[3]);
  const centreY = Number(match[4]);
  const left = Number(match[5]);
  return { left, right, top, width: right - left, height: (centreY - top) * 2 };
}

test('a two-line decision label widens the rhombus instead of spilling over it', async (t) => {
  const dir = await tempDir(t);
  const label = '是否满足急诊介入指征';
  const spec = path.join(dir, 'long-decision.json');
  await writeFile(spec, JSON.stringify({
    title: '长文案判断',
    nodes: [
      { id: 'a', label: '分诊', kind: 'input' },
      { id: 'd', label, kind: 'decision' },
      { id: 'b', label: '导管室', kind: 'process' },
    ],
    edges: [{ from: 'a', to: 'd' }, { from: 'd', to: 'b' }],
  }));
  const out = path.join(dir, 'long.svg');
  const made = run(['make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);

  const box = rhombus(await readFile(out, 'utf8'));
  assert.ok(box.width > 184, `the rhombus must grow for a wrapped label, got ${box.width}`);

  // A rhombus is only full width at its waist, so the widest line has to fit
  // inside the band the text block actually occupies.
  const lines = Math.ceil(textWidth(label) / 9);
  const textPx = Math.min(textWidth(label), 9) * 14;
  const band = (lines - 1) * 9 + 7;
  const available = box.width * (1 - band / (box.height / 2));
  assert.ok(available >= textPx, `text needs ${textPx}px, the rhombus offers ${available.toFixed(1)}px`);
});

test('a one-line decision keeps the historic 184px width', async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'short.json');
  await writeFile(spec, JSON.stringify({
    nodes: [
      { id: 'a', label: '分诊', kind: 'input' },
      { id: 'd', label: 'ST 抬高？', kind: 'decision' },
    ],
    edges: [{ from: 'a', to: 'd' }],
  }));
  const out = path.join(dir, 'short.svg');
  assert.equal(run(['make', '--spec', spec, '--out', out]).status, 0);
  assert.equal(rhombus(await readFile(out, 'utf8')).width, 184);
});

test('no edge label is drawn on top of its connector', async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'branch.json');
  await writeFile(spec, JSON.stringify({
    nodes: [
      { id: 'a', label: '分诊', kind: 'input' },
      { id: 'd', label: 'ST 抬高？', kind: 'decision' },
      { id: 'y', label: '导管室', kind: 'process' },
      { id: 'n', label: '漏诊风险', kind: 'risk' },
    ],
    edges: [
      { from: 'a', to: 'd' },
      { from: 'd', to: 'y', label: '是' },
      { from: 'd', to: 'n', label: '否 → 观察', style: 'dashed' },
    ],
  }));
  const out = path.join(dir, 'branch.svg');
  assert.equal(run(['make', '--spec', spec, '--out', out]).status, 0);
  const svg = await readFile(out, 'utf8');

  // A bent connector runs vertically at x = middle between the two ranks.
  const bent = [...svg.matchAll(
    /<path d="M [\d.]+ [\d.]+ L ([\d.]+) [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+" fill="none"/g)]
    .map((match) => Number(match[1]));
  assert.ok(bent.length > 0, 'expected at least one bent connector');

  const labels = [...svg.matchAll(
    /<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)"[^>]*font-size="12"[^>]*>([^<]*)<\/text>/g)]
    .map((match) => ({
      x: Number(match[1]), y: Number(match[2]), anchor: match[3], text: match[4],
    }));
  const texts = labels.map((label) => label.text);
  for (const expected of ['是', '否 → 观察']) {
    assert.ok(texts.includes(expected), `${expected} label is missing`);
  }
  for (const label of labels) {
    const widthPx = textWidth(label.text) * 12;
    const left = label.anchor === 'end'
      ? label.x - widthPx
      : label.anchor === 'start' ? label.x : label.x - widthPx / 2;
    const right = left + widthPx;
    for (const segmentX of bent) {
      const covered = left < segmentX && right > segmentX;
      assert.ok(!covered,
        `${label.text}: box ${left.toFixed(1)}..${right.toFixed(1)} covers the connector at x=${segmentX}`);
    }
  }
});

test('an over-wide plain chain rotates to TB and says so', async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'chain.svg');
  const made = run(['make', '--body', '一 → 二 → 三 → 四 → 五 → 六', '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.direction, 'TB');
  assert.match(made.json.directionNote, /1200px/);
  const size = canvas(await readFile(out, 'utf8'));
  assert.ok(size.width <= 1200, `rotated diagram must fit the report column, got ${size.width}`);
});

test('an explicit direction is never rotated', async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'forced.svg');
  const made = run(['make', '--body', '一 → 二 → 三 → 四 → 五 → 六',
    '--direction', 'LR', '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.direction, 'LR');
  assert.equal(made.json.directionNote, undefined);
  assert.ok(canvas(await readFile(out, 'utf8')).width > 1200);
});

test('a branched graph keeps LR even when wide', async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'wide-branch.json');
  await writeFile(spec, JSON.stringify({
    nodes: [
      { id: 'a', label: '分诊台', kind: 'input' },
      { id: 'b', label: '床旁心电', kind: 'service' },
      { id: 'c', label: '肌钙蛋白', kind: 'database' },
      { id: 'd', label: '判断', kind: 'decision' },
      { id: 'e', label: '导管室', kind: 'process' },
      { id: 'f', label: '院内 HIS', kind: 'external' },
    ],
    edges: [
      { from: 'a', to: 'b' }, { from: 'b', to: 'c' },
      { from: 'c', to: 'd' }, { from: 'd', to: 'e' },
      { from: 'a', to: 'f' },
    ],
  }));
  const out = path.join(dir, 'wide-branch.svg');
  const made = run(['make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.direction, 'LR', 'branching graphs keep the requested layout');
});

// 2026-11-12：`--report` 只是留档。旧写法带 --report 时只回 {"status","report"}，
// 于是 label-truncated / label-not-rendered / overflow 三种不同修法全被藏进文件。
test('audit --report still prints issues on stdout', async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'long-label.json');
  await writeFile(spec, JSON.stringify({
    nodes: [
      { id: 'a', label: '这是一段特别长的节点说明文字，用来测试超过三行以后是否会被判定为截断丢字，需要足够多的字数才会触发这个检查，所以这里继续往后面写很多很多字' },
      { id: 'b', label: '乙' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  }));
  const svg = path.join(dir, 'long.svg');
  const made = run(['make', '--spec', spec, '--out', svg]);
  assert.equal(made.status, 0, made.text);

  const report = path.join(dir, 'audit.json');
  const audited = run(['audit', '--input', svg, '--spec', spec, '--report', report]);
  assert.equal(audited.status, 1, audited.text);
  assert.equal(audited.json?.status, 'error');
  const codes = (audited.json?.issues ?? []).map((item) => item.code);
  assert.ok(codes.includes('label-truncated'), `stdout 必须带 issues 明细，实际 ${codes}`);
  const written = JSON.parse(await readFile(report, 'utf8'));
  assert.deepEqual(written.issues.map((item) => item.code), codes);
});
