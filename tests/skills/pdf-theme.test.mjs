// T4.2: themed PDF reports, markdown tables and an optional table of contents.
//
// Without --design-theme the report uses the shared default theme (clinical).
// --design-theme none is the explicit escape hatch back to the old
// black-and-white report.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pdfScript = path.join(repo, 'skills/pdf/scripts/pdf.sh');

function run(args) {
  const result = spawnSync('bash', [pdfScript, ...args], {
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

const READY = run(['check']).json?.usable === true;
const SKIP = READY ? false : 'pdf runtime not installed';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pdf-theme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function inspect(dir, pdf, name = 'inspect.json') {
  const out = path.join(dir, name);
  const result = run(['inspect', '--input', pdf, '--out', out]);
  assert.equal(result.status, 0, result.text);
  return JSON.parse(await readFile(out, 'utf8'));
}

test('without --design-theme the report uses the clinical default', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'plain.pdf');
  const made = run(['make', '--title', '默认报告', '--body', '患者胸痛三小时。', '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.theme?.id, 'clinical', 'the default report must use clinical');
  assert.equal(made.json.theme?.label, '临床晨光');

  const details = await inspect(dir, out);
  const names = details.fonts.map((font) => font.name).join(',');
  assert.match(names, /NotoSansSC/, 'the default path still uses the bundled sans face');
  assert.doesNotMatch(names, /NotoSerifSC/);
  assert.ok(details.fonts.some((font) => font.embedded), 'the CJK face must be embedded');
});

test('--design-theme none keeps the neutral black-and-white report', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'neutral.pdf');
  const made = run(['make', '--title', '中性报告', '--body', '患者胸痛三小时。',
    '--design-theme', 'none', '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.theme, undefined, 'a neutral report must not claim a theme');

  const details = await inspect(dir, out);
  const names = details.fonts.map((font) => font.name).join(',');
  assert.match(names, /NotoSansSC/);
  assert.ok(details.fonts.some((font) => font.embedded));
});

test('all six themes render and report their Chinese label', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const expected = {
    clinical: '临床晨光',
    academic: '青黛循证',
    trauma: '松风急救',
    archive: '宣纸病案',
    edu: '杏林宣教',
    mono: '灰阶印刷',
  };
  for (const [id, label] of Object.entries(expected)) {
    const out = path.join(dir, `${id}.pdf`);
    const made = run(['make', '--title', '主题样张', '--body', '患者男性，58 岁。',
      '--design-theme', id, '--out', out]);
    assert.equal(made.status, 0, `${id}: ${made.text}`);
    assert.equal(made.json.theme?.id, id, `${id}: theme id`);
    assert.equal(made.json.theme?.label, label, `${id}: theme label`);
    const details = await inspect(dir, out, `${id}.json`);
    const names = details.fonts.map((font) => font.name).join(',');
    if (id === 'archive') {
      assert.match(names, /NotoSerifSC/, 'archive is the serif theme');
    } else {
      assert.match(names, /NotoSansSC/);
    }
  }
});

test('Chinese names and aliases resolve to the same theme id', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  for (const [name, id] of [['宣纸病案', 'archive'], ['临床', 'clinical'], ['循证', 'academic']]) {
    const out = path.join(dir, `${id}.pdf`);
    const made = run(['make', '--title', '别名探针', '--body', '正文。',
      '--design-theme', name, '--out', out]);
    assert.equal(made.status, 0, `${name}: ${made.text}`);
    assert.equal(made.json.theme?.id, id, `${name} should map to ${id}`);
  }
});

test('an unknown theme is refused and the available themes are listed', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'bad.pdf');
  const made = run(['make', '--title', 'x', '--body', 'y', '--design-theme', '不存在的主题',
    '--out', out]);
  assert.notEqual(made.status, 0);
  for (const label of ['临床晨光', '青黛循证', '松风急救', '宣纸病案', '杏林宣教', '灰阶印刷']) {
    assert.ok(made.text.includes(label), `error text should list ${label}`);
  }
});

test('spec.designTheme is honoured like the CLI flag', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '循证摘要',
    designTheme: 'academic',
    body: '研究对象共 120 例。',
  }));
  const out = path.join(dir, 'spec.pdf');
  const made = run(['make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.theme?.id, 'academic');
});

test('markdown pipe tables become real tables instead of literal pipes', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const markdown = path.join(dir, 'body.md');
  await writeFile(markdown, [
    '# 病例摘要', '',
    '| 指标 | 数值 | 参考区间 |',
    '| --- | --- | --- |',
    '| 肌钙蛋白 | 升高 | 0-0.04 |',
    '| 白细胞 | 12.3 | 3.5-9.5 |',
    '', '## 结论', '患者胸痛 3 小时。', '',
  ].join('\n'));
  const out = path.join(dir, 'table.pdf');
  const made = run(['make', '--title', '表格测试', '--markdown', markdown, '--out', out]);
  assert.equal(made.status, 0, made.text);

  const tablesPath = path.join(dir, 'tables.json');
  const textPath = path.join(dir, 'text.json');
  const inspected = run(['inspect', '--input', out, '--out', path.join(dir, 'i.json'),
    '--tables-out', tablesPath, '--text-out', textPath]);
  assert.equal(inspected.status, 0, inspected.text);

  const tables = JSON.parse(await readFile(tablesPath, 'utf8')).pages
    .flatMap((page) => page.tables ?? []);
  assert.equal(tables.length, 1, 'exactly one table should be detected');
  assert.deepEqual(tables[0][0].map((cell) => (cell ?? '').trim()), ['指标', '数值', '参考区间']);
  assert.deepEqual(tables[0][2].map((cell) => (cell ?? '').trim()), ['白细胞', '12.3', '3.5-9.5']);

  const text = JSON.parse(await readFile(textPath, 'utf8')).pages
    .map((page) => page.text).join('\n');
  assert.doesNotMatch(text, /\|\s*指标\s*\|/, 'pipe syntax must not survive as body text');
  // layout=True pads CJK with spaces, so compare with whitespace removed.
  assert.match(text.replace(/\s+/gu, ''), /患者胸痛3小时/, 'text after the table must still be present');
});

test('a pipe block without a delimiter row stays plain text', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const markdown = path.join(dir, 'body.md');
  await writeFile(markdown, '# 备注\n\n收缩压 | 舒张压 属于记录格式，不是表格。\n');
  const out = path.join(dir, 'no-table.pdf');
  const made = run(['make', '--title', '非表格', '--markdown', markdown, '--out', out]);
  assert.equal(made.status, 0, made.text);
  const tablesPath = path.join(dir, 'tables.json');
  run(['inspect', '--input', out, '--out', path.join(dir, 'i.json'), '--tables-out', tablesPath]);
  const tables = JSON.parse(await readFile(tablesPath, 'utf8')).pages
    .flatMap((page) => page.tables ?? []);
  assert.equal(tables.length, 0);
});

test('--toc lists the level-1 headings on the first page', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const markdown = path.join(dir, 'body.md');
  await writeFile(markdown, [
    '## 资料概览', '教学对象甲。', '',
    '## 已知数据', '体温 37.0 C。', '',
    '## 资料缺口', '影像未提供。', '',
  ].join('\n'));
  const out = path.join(dir, 'toc.pdf');
  const made = run(['make', '--title', '教学资料摘要', '--markdown', markdown, '--toc', '--out', out]);
  assert.equal(made.status, 0, made.text);
  const textPath = path.join(dir, 'text.json');
  run(['inspect', '--input', out, '--out', path.join(dir, 'i.json'), '--text-out', textPath]);
  const pages = JSON.parse(await readFile(textPath, 'utf8')).pages;
  const firstPage = pages[0].text;
  assert.match(firstPage, /目录/);
  for (const heading of ['资料概览', '已知数据', '资料缺口']) {
    assert.match(firstPage, new RegExp(heading), `the TOC should list ${heading}`);
  }
  // The TOC gets its own page: body copy must start on page 2, otherwise the
  // entries and the report text fight for the same rows.
  assert.doesNotMatch(firstPage, /教学对象甲/, 'the body must not share the TOC page');
  assert.match(pages[1].text, /教学对象甲/);
});

test('--toc reports the entries it drew, with levels and page numbers', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const markdown = path.join(dir, 'body.md');
  await writeFile(markdown, [
    '## 第一章', '正文一。', '',
    '### 1.1 小节', '正文二。', '',
    '#### 1.1.1 更深一层', '正文三。', '',
    '## 第二章', '正文四。', '',
  ].join('\n'));
  const out = path.join(dir, 'toc-levels.pdf');
  const made = run(['make', '--title', '目录层级', '--markdown', markdown, '--toc', '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.deepEqual(made.json.tocEntries, [
    { level: 0, text: '第一章', page: 2 },
    { level: 1, text: '1.1 小节', page: 2 },
    { level: 0, text: '第二章', page: 2 },
  ], '#### must stay out of the TOC while ### gets its own depth');
  assert.equal(made.json.pages, 2, 'the TOC page is added in front of the body');
});

test('a table of contents longer than a page continues on the next page', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const lines = [];
  for (let index = 1; index <= 40; index += 1) {
    lines.push(`## 第 ${index} 节`, `正文 ${index}。`, '');
  }
  const markdown = path.join(dir, 'many.md');
  await writeFile(markdown, lines.join('\n'));
  const out = path.join(dir, 'many.pdf');
  const made = run(['make', '--title', '多章目录', '--markdown', markdown, '--toc', '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.tocEntries.length, 40, 'every heading must be listed');
  const textPath = path.join(dir, 'text.json');
  run(['inspect', '--input', out, '--out', path.join(dir, 'i.json'), '--text-out', textPath]);
  const pages = JSON.parse(await readFile(textPath, 'utf8')).pages;
  assert.match(pages[0].text, /第 1 节/, 'the first rows sit on the TOC page');
  assert.match(pages[1].text, /第 40 节/, 'the overflow continues on the next page');
});

test('a long table repeats its header on the next page', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const rows = ['# 长表', '', '| 序号 | 项目 | 数值 |', '| --- | --- | --- |'];
  for (let index = 1; index <= 60; index += 1) {
    rows.push(`| ${index} | 检查项 ${index} | ${(index * 1.5).toFixed(1)} |`);
  }
  const markdown = path.join(dir, 'long.md');
  await writeFile(markdown, `${rows.join('\n')}\n`);
  const out = path.join(dir, 'long.pdf');
  const made = run(['make', '--title', '长表', '--markdown', markdown,
    '--design-theme', 'mono', '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.ok(made.json.pages >= 2, 'sixty rows must span more than one page');

  const tablesPath = path.join(dir, 'tables.json');
  run(['inspect', '--input', out, '--out', path.join(dir, 'i.json'), '--tables-out', tablesPath]);
  const pages = JSON.parse(await readFile(tablesPath, 'utf8')).pages;
  const secondPageTables = pages[1]?.tables ?? [];
  assert.ok(secondPageTables.length >= 1, 'the continuation page repeats the header row');
  assert.deepEqual(
    secondPageTables[0][0].map((cell) => (cell ?? '').trim()),
    ['序号', '项目', '数值'],
  );
});

// 2026-11-12：报告文件只是留档。旧写法 `audit` 只回 hardFailures 的**个数**、
// `deliver` 只回三个 stage 状态字符串，"哪一关为什么没过"全在 json 里。
// 现在 stdout 必须带原文。
test('audit prints the full report, not just counts', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const pdf = path.join(dir, 'audit.pdf');
  const made = run(['make', '--title', '审计', '--out', pdf]);
  assert.equal(made.status, 0, made.text);

  const reportPath = path.join(dir, 'audit.json');
  const audited = run(['audit', '--input', pdf, '--out', reportPath]);
  assert.equal(audited.status, 0, audited.text);
  assert.ok(Array.isArray(audited.json?.hardFailures), 'stdout 必须带 hardFailures 数组');
  assert.ok(Array.isArray(audited.json?.warnings), 'stdout 必须带 warnings 数组');
  assert.match(audited.json?.report ?? '', /audit\.json$/u, '报告路径要一起带出来');
  // 文件与 stdout 是同一份
  const written = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.deepEqual(written.hardFailures, audited.json.hardFailures);
});

test('deliver prints the gate details, not just stage names', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const pdf = path.join(dir, 'deliver.pdf');
  const made = run(['make', '--title', '交付', '--out', pdf]);
  assert.equal(made.status, 0, made.text);

  const reportPath = path.join(dir, 'delivery.json');
  const delivered = run(['deliver', '--input', pdf, '--report', reportPath]);
  assert.ok(delivered.json, delivered.text);
  assert.ok(delivered.json.gates && Array.isArray(delivered.json.gates.errors), 'stdout 必须带 gates.errors');
  assert.ok(delivered.json.audit && Array.isArray(delivered.json.audit.hardFailures));
  assert.match(delivered.json.report ?? '', /delivery\.json$/u, '报告路径要一起带出来');
});
