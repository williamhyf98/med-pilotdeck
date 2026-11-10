// T4.1: the capability matrix must describe what the code actually does.
//
// The document carries a small machine-readable block; every claim in it is
// checked here against the real CLIs, so adding a theme or a layout without
// updating the matrix fails the suite.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { listThemes } from '../../skills/_shared/tokens.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const matrixPath = path.join(repo, 'docs/format-capability-matrix.zh.md');
const docxScript = path.join(repo, 'skills/docx/scripts/docx.sh');
const pptxScript = path.join(repo, 'skills/pptx/scripts/pptx.sh');
const pdfScript = path.join(repo, 'skills/pdf/scripts/pdf.sh');
const xlsxScript = path.join(repo, 'skills/spreadsheets/scripts/spreadsheet.sh');
const themesCss = path.join(repo, 'skills/frontend-slides/assets/themes/pd-themes.css');

// 8x8 opaque PNG; transparent images are rejected by the DOCX skill.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWOD'
  + 'FTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', ...options });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function runtime(script) {
  const result = run('bash', [script, 'check']);
  return result.json?.status === 'ok' || result.json?.usable === true;
}

const RUNTIMES = {
  docx: runtime(docxScript),
  pptx: runtime(pptxScript),
  pdf: runtime(pdfScript),
  xlsx: runtime(xlsxScript),
};

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'capability-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function matrix() {
  const text = await readFile(matrixPath, 'utf8');
  const match = text.match(/<!-- capability-matrix:begin -->([\s\S]*?)<!-- capability-matrix:end -->/);
  assert.ok(match, 'the matrix document must keep its machine-readable block');
  const json = match[1].match(/```json([\s\S]*?)```/);
  assert.ok(json, 'the machine-readable block must be a json code fence');
  return { text, data: JSON.parse(json[1]) };
}

test('the matrix lists the same six themes the token file ships', async () => {
  const { data } = await matrix();
  const themes = await listThemes();
  assert.deepEqual(data.themes.ids, themes.themes.map((theme) => theme.id));
  assert.equal(data.themes.ids.length, 6);
  assert.deepEqual(
    [...data.themes.supported, ...data.themes.notSupported].sort(),
    ['diagram', 'docx', 'html', 'pdf', 'pptx', 'xlsx'],
  );
  assert.equal(data.content.pdf.markdownTable, true, 'T4.2 renders markdown tables in PDF');
  assert.equal(data.content.xlsx.nativeChart, true);
  assert.equal(data.content.docx.nativeTable, true);
  assert.equal(data.content.pptx.tableLayout, true);
});

test('the documented default theme is what the CLIs actually do', async (t) => {
  const { data } = await matrix();
  const shared = await listThemes();
  const defaultTheme = shared.themes.find((theme) => theme.default)?.id;
  assert.equal(defaultTheme, 'clinical', 'skills/_shared/design-tokens.json must default to clinical');
  assert.equal(data.defaults.theme, defaultTheme);
  assert.deepEqual(Object.keys(data.defaults.byFormat).sort(), ['html', 'pdf', 'pptx']);
  for (const [format, theme] of Object.entries(data.defaults.byFormat)) {
    assert.equal(theme, data.defaults.theme, `${format} must default to ${data.defaults.theme}`);
  }
  // Every other format either has no theme axis or keeps the old neutral look.
  const themed = new Set(Object.keys(data.defaults.byFormat));
  assert.deepEqual([...data.defaults.unchanged].sort(), data.themes.supported.filter((f) => !themed.has(f)).sort());

  const dir = await tempDir(t);
  if (RUNTIMES.pptx) {
    const made = run('bash', [pptxScript, 'make', '--title', '默认探针', '--body', '患者胸痛。',
      '--out', path.join(dir, 'd.pptx')]);
    assert.equal(made.status, 0, made.text);
    assert.equal(made.json?.theme, 'clinical', 'PPTX without --theme must build clinical');
  }
  if (RUNTIMES.pdf) {
    const made = run('bash', [pdfScript, 'make', '--title', '默认探针', '--body', '患者胸痛。',
      '--out', path.join(dir, 'd.pdf')]);
    assert.equal(made.status, 0, made.text);
    assert.equal(made.json?.theme?.id, 'clinical', 'PDF without --design-theme must build clinical');
  }
  // HTML has no generator: the default lives in the skill text, and the theme
  // listing is the only machine-readable surface that can confirm it.
  const listed = run('bash', [path.join(repo, 'skills/frontend-slides/scripts/html.sh'), 'themes']);
  assert.equal(listed.status, 0, listed.text);
  assert.equal(listed.json?.default, data.defaults.theme);
  assert.deepEqual(listed.json?.themes.filter((item) => item.default).map((item) => item.id),
    [data.defaults.theme], 'exactly one HTML theme is the default');
});

test('theme support flags match the real command surface', async (t) => {
  const { data } = await matrix();

  await t.test('PPTX, DOCX and HTML expose all six themes', async () => {
    if (!RUNTIMES.pptx) return t.diagnostic('pptx runtime missing; theme list not probed');
    const listed = run('bash', [pptxScript, 'themes']);
    assert.equal(listed.status, 0, listed.text);
    // pptx.sh themes reports the identifier as `name`; the token module calls it `id`.
    const ids = (listed.json?.themes ?? []).map((theme) => theme.id ?? theme.name);
    assert.deepEqual(ids.sort(), [...data.themes.ids].sort());

    const css = await readFile(themesCss, 'utf8');
    for (const id of data.themes.ids) {
      assert.match(css, new RegExp(`\\[data-pd-theme="${id}"\\]`), `${id} missing from pd-themes.css`);
    }

    if (!RUNTIMES.docx) return t.diagnostic('docx runtime missing; --design-theme not probed');
    const dir = await tempDir(t);
    for (const id of data.themes.ids) {
      const out = path.join(dir, `${id}.docx`);
      const made = run('bash', [docxScript, 'make', '--title', '主题探针', '--body', '患者胸痛。',
        '--design-theme', id, '--out', out]);
      assert.equal(made.status, 0, `${id}: ${made.text}`);
    }
  });

  await t.test('PDF, XLSX and diagram all accept a theme', async () => {
    const dir = await tempDir(t);
    if (RUNTIMES.pdf) {
      const pdf = run('bash', [pdfScript, 'make', '--title', 't', '--body', 'b',
        '--out', path.join(dir, 'x.pdf'), '--design-theme', 'academic']);
      assert.equal(pdf.status, 0, 'PDF accepts --design-theme since T4.2');
      assert.equal(pdf.json?.theme?.id, 'academic');
    }
    if (RUNTIMES.xlsx) {
      const xlsx = run('bash', [xlsxScript, 'make', '--title', 't', '--body', 'b',
        '--out', path.join(dir, 'x.xlsx'), '--design-theme', 'academic']);
      assert.equal(xlsx.status, 0, 'XLSX accepts --design-theme since T4.3');
      assert.equal(xlsx.json?.theme?.id, 'academic');
      const ambiguous = run('bash', [xlsxScript, 'make', '--title', 't', '--body', 'b',
        '--theme', 'academic', '--out', path.join(dir, 'y.xlsx')]);
      assert.notEqual(ambiguous.status, 0, '--theme stays ambiguous for XLSX');
      assert.match(ambiguous.text, /--theme is ambiguous/);
    }
    const diagram = run('bash', [path.join(repo, 'skills/diagram-maker/scripts/diagram.sh'),
      'make', '--body', 'a → b', '--out', path.join(dir, 'x.svg'), '--design-theme', 'academic']);
    assert.equal(diagram.status, 0, 'diagram accepts --design-theme since T4.4');
    assert.equal(diagram.json?.designTheme?.id, 'academic');
    assert.equal(diagram.json?.theme, 'clean', 'the layout axis is untouched');
  });
});

test('DOCX spec blocks: native table, image and table of contents', {
  skip: RUNTIMES.docx ? false : 'docx runtime not installed',
}, async (t) => {
  const dir = await tempDir(t);
  const image = path.join(dir, 'img.png');
  await writeFile(image, Buffer.from(PNG_BASE64, 'base64'));
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    page: 'a4',
    content: [
      { type: 'heading', level: 1, text: '指标' },
      { type: 'table', headers: ['指标', '值'], rows: [['肌钙蛋白', '升高']], caption: '表1' },
      { type: 'callout', label: '结论', text: '结构完整' },
      { type: 'image', path: image, caption: '图1' },
      { type: 'toc' },
    ],
  }));
  const out = path.join(dir, 'probe.docx');
  const made = run('bash', [docxScript, 'make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);
  const inspected = run('bash', [docxScript, 'inspect', '--input', out]);
  assert.equal(inspected.status, 0, inspected.text);
  assert.equal(inspected.json.table_count, 1, 'the table block must produce a native Word table');
  // inspect() returns image_parts as a count, not a list.
  assert.ok((inspected.json.image_parts ?? 0) >= 1, 'the image block must embed a picture');
  assert.ok((inspected.json.headings ?? []).length >= 1, 'the toc block adds a heading');
});

test('XLSX spec: native chart and conditional formatting reach the audit', {
  skip: RUNTIMES.xlsx ? false : 'spreadsheet runtime not installed',
}, async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    sheets: [{
      name: '数据',
      headers: ['类别', '人数'],
      rows: [['急诊', 12], ['门诊', 30]],
      conditionalFormatting: [{
        range: 'B2:B3',
        rules: [{
          type: 'cellIs',
          operator: 'greaterThan',
          formulae: [20],
          style: { font: { color: { argb: 'FFB91C1C' } } },
        }],
      }],
      charts: [{
        type: 'column',
        title: '人数',
        categories: 'A2:A3',
        series: [{ name: '人数', values: 'B2:B3' }],
        anchor: { from: 'E2', to: 'M16' },
      }],
    }],
  }));
  const out = path.join(dir, 'probe.xlsx');
  const made = run('bash', [xlsxScript, 'make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);

  const inspected = run('bash', [xlsxScript, 'inspect', '--input', out]);
  assert.equal(inspected.status, 0, inspected.text);
  assert.ok((inspected.json.package?.features?.charts ?? 0) >= 1, 'the chart must be a native chart');

  const requirements = path.join(dir, 'requirements.json');
  await writeFile(requirements, JSON.stringify({
    requiredSheets: ['数据'],
    // A chart requirement must carry its provenance: which ranges the chart is
    // drawn from, and how many data points it must have.
    requiredNativeCharts: [{
      sheet: '数据', type: 'column', minPoints: 2, sourceRanges: ['A2:A3', 'B2:B3'],
    }],
    requiredConditionalFormatting: [{ sheet: '数据', range: 'B2:B3' }],
  }));
  const audited = run('bash', [xlsxScript, 'audit', '--input', out,
    '--requirements', requirements]);
  assert.equal(audited.status, 0, audited.text);

  // The provenance gate must bite: dropping sourceRanges/minPoints fails even
  // though the chart itself is present.
  const bareRequirements = path.join(dir, 'bare.json');
  await writeFile(bareRequirements, JSON.stringify({
    requiredNativeCharts: [{ sheet: '数据', type: 'column' }],
  }));
  const bare = run('bash', [xlsxScript, 'audit', '--input', out,
    '--requirements', bareRequirements]);
  assert.notEqual(bare.status, 0, 'a chart requirement without provenance must fail');
  assert.match(bare.text, /native_chart_requirement_floor/);
});

test('PPTX spec layouts: timeline, chart and table all render', {
  skip: RUNTIMES.pptx ? false : 'pptx runtime not installed',
}, async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '能力探针',
    slides: [
      { type: 'timeline', title: '时间线', steps: [{ label: '入院' }, { label: '手术' }, { label: '出院' }] },
      { type: 'chart', title: '趋势', series: [{ name: '例数', labels: ['Q1', 'Q2'], values: [3, 5] }] },
      { type: 'table', title: '指标', rows: [['指标', '值'], ['肌钙蛋白', '升高']] },
    ],
  }));
  const out = path.join(dir, 'probe.pptx');
  const made = run('bash', [pptxScript, 'make', '--spec', spec, '--out', out]);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.slides, 4, 'title slide plus the three requested layouts');
});

test('PDF markdown tables render as a native table (T4.2)', {
  skip: RUNTIMES.pdf ? false : 'pdf runtime not installed',
}, async (t) => {
  const dir = await tempDir(t);
  const markdown = path.join(dir, 'body.md');
  await writeFile(markdown, '# 病例摘要\n\n| 指标 | 值 |\n| --- | --- |\n| 肌钙蛋白 | 升高 |\n');
  const out = path.join(dir, 'probe.pdf');
  const made = run('bash', [pdfScript, 'make', '--title', '表格测试', '--markdown', markdown,
    '--out', out]);
  assert.equal(made.status, 0, made.text);

  const textPath = path.join(dir, 'text.json');
  const tablesPath = path.join(dir, 'tables.json');
  const inspected = run('bash', [pdfScript, 'inspect', '--input', out,
    '--out', path.join(dir, 'inspect.json'), '--text-out', textPath, '--tables-out', tablesPath]);
  assert.equal(inspected.status, 0, inspected.text);
  const extracted = await readFile(textPath, 'utf8');
  assert.doesNotMatch(extracted, /\|\s*指标\s*\|/,
    'markdown pipes must not survive as body text');
  const tables = JSON.parse(await readFile(tablesPath, 'utf8')).pages
    .flatMap((page) => page.tables ?? []);
  assert.equal(tables.length, 1, 'the pipe table must become a real PDF table');
  assert.deepEqual(tables[0][0].map((cell) => (cell ?? '').trim()), ['指标', '值']);
});
