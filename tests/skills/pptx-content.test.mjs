// T4.3: markdown tables, themed charts and the three medical layouts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { loadTokens } from '../../skills/_shared/tokens.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pptxScript = path.join(repo, 'skills/pptx/scripts/pptx.sh');

function run(args) {
  const result = spawnSync('bash', [pptxScript, ...args], {
    cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const READY = run(['check']).json?.status === 'ok';
const SKIP = READY ? false : 'pptx runtime not installed';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pptx-content-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function slideXml(pptxPath, number) {
  return execFileSync('unzip', ['-p', pptxPath, `ppt/slides/slide${number}.xml`], { encoding: 'utf8' });
}

async function chartXml(pptxPath, number) {
  return execFileSync('unzip', ['-p', pptxPath, `ppt/charts/chart${number}.xml`], { encoding: 'utf8' });
}

async function zipEntries(pptxPath) {
  return execFileSync('unzip', ['-Z1', pptxPath], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

test('markdown pipe tables become table slides', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const markdown = path.join(dir, 'body.md');
  await writeFile(markdown, [
    '# 胸痛评估', '',
    '## 检验结果', '',
    '| 指标 | 数值 | 参考区间 |',
    '| --- | --- | --- |',
    '| 肌钙蛋白 | 升高 | < 0.04 |',
    '| 白细胞 | 12.3 | 3.5-9.5 |',
    '',
    '## 结论', '',
    '单支血管病变可能性大。', '',
  ].join('\n'));
  const out = path.join(dir, 'table.pptx');
  const made = run(['make', '--markdown', markdown, '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.slides, 3, 'title + table + conclusion');

  const xml = await slideXml(out, 2);
  assert.match(xml, /<a:tbl>/, 'the pipe table must become a native PPTX table');
  assert.match(xml, /肌钙蛋白/);
  assert.match(xml, /参考区间/);
  const titleSlide = await slideXml(out, 3);
  assert.match(titleSlide, /结论/, 'text after the table keeps its own slide');
});

test('a table right under a heading reuses that heading as the slide title', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const markdown = path.join(dir, 'body.md');
  await writeFile(markdown, [
    '# 病例', '', '## 实验室检查', '',
    '| 项目 | 值 |', '| --- | --- |', '| 肌酐 | 88 |', '',
  ].join('\n'));
  const out = path.join(dir, 'heading.pptx');
  const made = run(['make', '--markdown', markdown, '--out', out]);
  assert.equal(made.status, 0, made.text);
  const xml = await slideXml(out, 2);
  assert.match(xml, /实验室检查/);
  assert.match(xml, /<a:tbl>/);
});

test('chart slides render a real chart element and reject bad input', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '趋势',
    slides: [
      { type: 'chart', title: '默认柱状', series: [{ name: '例数', labels: ['Q1', 'Q2'], values: [3, 5] }] },
      { type: 'chart', chartType: 'line', title: '折线', series: [{ name: '例数', labels: ['Q1', 'Q2'], values: [3, 5] }] },
      { type: 'chart', chartType: 'column', title: '柱形', series: [{ name: '例数', labels: ['Q1', 'Q2'], values: [3, 5] }] },
    ],
  }));
  const out = path.join(dir, 'charts.pptx');
  const made = run(['make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);
  const slideTwo = await slideXml(out, 2);
  assert.match(slideTwo, /<c:chart /, 'the slide must reference a chart part');
  const bars = await chartXml(out, 1);
  assert.match(bars, /<c:barChart>/, 'the default chart must not render an empty frame');
  const line = await chartXml(out, 2);
  assert.match(line, /<c:lineChart>/);
  const column = await chartXml(out, 3);
  assert.match(column, /<c:barChart>/);
  assert.match(column, /<c:barDir val="col"\/>/, 'column is an alias for a vertical bar chart');

  const badSpec = path.join(dir, 'bad.json');
  await writeFile(badSpec, JSON.stringify({
    title: 'x',
    slides: [{ type: 'chart', chartType: 'donut-hole', series: [{ name: 'a', labels: ['Q1'], values: [1] }] }],
  }));
  const bad = run(['make', '--spec', badSpec, '--out', path.join(dir, 'bad.pptx')]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.text, /Unsupported chartType/);
  assert.match(bad.text, /donut-hole/);

  const emptySpec = path.join(dir, 'empty.json');
  await writeFile(emptySpec, JSON.stringify({ title: 'x', slides: [{ type: 'chart', title: '空' }] }));
  const empty = run(['make', '--spec', emptySpec, '--out', path.join(dir, 'empty.pptx')]);
  assert.notEqual(empty.status, 0, 'a chart slide without series must fail loudly');
  assert.match(empty.text, /at least one series/);
});

test('chart series follow the theme chart palette', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const { tokens } = await loadTokens();
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '主题图表',
    theme: 'archive',
    slides: [{
      type: 'chart',
      chartType: 'column',
      title: '序列',
      series: [
        { name: 'A', labels: ['Q1', 'Q2'], values: [1, 2] },
        { name: 'B', labels: ['Q1', 'Q2'], values: [2, 3] },
      ],
    }],
  }));
  const out = path.join(dir, 'themed.pptx');
  const made = run(['make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);
  const xml = await chartXml(out, 1);
  const palette = tokens.themes.archive.chart.series;
  for (const color of palette.slice(0, 2)) {
    assert.match(xml, new RegExp(`srgbClr val="${color}"`), `series colour ${color} must come from the theme`);
  }
  assert.match(xml, new RegExp(`srgbClr val="${tokens.themes.archive.chart.grid}"`), 'grid lines use the theme grid colour');
});

test('case, imaging and evidence layouts render their content', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const image = path.join(dir, 'panel.png');
  // 4x3 opaque PNG.
  await writeFile(image, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEklEQVR4nGP8z4APMOGVHbHSAEEsAROxCnMTAAAAAElFTkSuQmCC',
    'base64',
  ));
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '急诊胸痛',
    theme: 'archive',
    slides: [
      {
        type: 'case',
        title: '病例概况',
        profile: [{ label: '年龄', value: '58 岁' }, { label: '分诊', value: 'II 级' }],
        left: { heading: '主诉', items: ['胸痛 3 小时'] },
        right: { heading: '检验', items: ['肌钙蛋白升高'] },
      },
      {
        type: 'imaging',
        title: '胸部 CT',
        image: { path: image, caption: '图 1 CT' },
        findings: ['未见夹层'],
        impression: '未见急性主动脉综合征征象。',
      },
      {
        type: 'evidence',
        title: '证据与推荐',
        verdict: '建议 24 小时内行冠脉造影。',
        items: [{ level: 'I', label: '早期侵入', detail: 'GRACE > 140' }],
      },
    ],
  }));
  const out = path.join(dir, 'layouts.pptx');
  const made = run(['make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.slides, 4);

  const caseXml = await slideXml(out, 2);
  assert.match(caseXml, /病例概况/);
  assert.match(caseXml, /58 岁/);
  const imagingXml = await slideXml(out, 3);
  assert.match(imagingXml, /图 1 CT/);
  assert.match(imagingXml, /未见急性主动脉综合征征象/);
  const entries = await zipEntries(out);
  assert.ok(
    entries.some((name) => /^ppt\/media\/.*\.png$/u.test(name)),
    'the imaging layout embeds the local picture',
  );
  const evidenceXml = await slideXml(out, 4);
  assert.match(evidenceXml, /建议 24 小时内行冠脉造影/);
  assert.match(evidenceXml, /GRACE &gt; 140|GRACE > 140/);
});

test('the imaging layout falls back to a labelled placeholder', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '影像缺失',
    slides: [{ type: 'imaging', title: '胸部 CT', findings: ['待补充'], impression: '待补充' }],
  }));
  const out = path.join(dir, 'placeholder.pptx');
  const made = run(['make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);
  const xml = await slideXml(out, 2);
  assert.match(xml, /影像未提供/);
});
