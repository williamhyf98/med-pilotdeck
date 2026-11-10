// T4.3: XLSX design themes (colours, tab, chart palette) and the guard rails.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadTokens } from '../../skills/_shared/tokens.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const xlsxScript = path.join(repo, 'skills/spreadsheets/scripts/spreadsheet.sh');

function run(args) {
  const result = spawnSync('bash', [xlsxScript, ...args], {
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

const CHECK = run(['check']).json;
const READY = CHECK?.status === 'ok' || CHECK?.usable === true;
const SKIP = READY ? false : 'spreadsheet runtime not installed';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xlsx-theme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function part(file, name) {
  return execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' });
}

async function writeSpec(dir, document) {
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify(document));
  return spec;
}

const CHART_SHEET = {
  name: '数据',
  headers: ['类别', '人数'],
  rows: [['急诊', 12], ['门诊', 30]],
  charts: [{
    type: 'column',
    title: '人数',
    categories: 'A2:A3',
    series: [{ name: '人数', values: 'B2:B3' }],
    anchor: { from: 'E2', to: 'M16' },
  }],
};

test('a theme colours the title, the sheet tab and the table header', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const { tokens } = await loadTokens();
  const theme = tokens.themes.archive;
  const spec = await writeSpec(dir, { designTheme: '宣纸病案', sheets: [CHART_SHEET] });
  const out = path.join(dir, 'themed.xlsx');
  const made = run(['make', '--spec', spec, '--out', out, '--force']);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.theme?.id, 'archive');
  assert.equal(made.json.theme?.label, '宣纸病案');

  const sheet = part(out, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, new RegExp(`<tabColor rgb="FF${theme.colors.accent}"`), 'tab colour uses the accent');
  const styles = part(out, 'xl/styles.xml');
  assert.ok(styles.includes(`FF${theme.colors.primary}`), 'the title and header use the primary colour');
  assert.ok(styles.includes(`FF${theme.colors.ink}`), 'body cells use the ink colour');
  assert.ok(styles.includes('SimSun'), 'the serif theme switches the body font role');
  // The default header fill must be repainted, otherwise a themed workbook
  // keeps the built-in teal band that belongs to no palette.
  assert.doesNotMatch(styles, /FF0F766E/, 'the default header fill is replaced by the theme');
  assert.ok(
    styles.includes(`<patternFill patternType="solid"><fgColor rgb="FF${theme.colors.primary}"/><bgColor rgb="FF${theme.colors.primary}"/></patternFill>`),
    'the header fill writes both colours so LibreOffice does not drop it',
  );
});

test('an unthemed header keeps the default fill, with both colours written', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const spec = await writeSpec(dir, { sheets: [CHART_SHEET] });
  const out = path.join(dir, 'plain-header.xlsx');
  const made = run(['make', '--spec', spec, '--out', out, '--force']);
  assert.equal(made.status, 0, made.text);
  const styles = part(out, 'xl/styles.xml');
  assert.ok(
    styles.includes('<patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor rgb="FF0F766E"/></patternFill>'),
    'the neutral path keeps the old teal, but ExcelJS alone would drop the bgColor and LibreOffice renders nothing',
  );
});

test('a line series keeps the schema order that Excel accepts', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const spec = await writeSpec(dir, {
    sheets: [{
      name: '趋势',
      headers: ['时间', '数值'],
      rows: [['0h', 1], ['1h', 2], ['2h', 3]],
      charts: [{
        type: 'line',
        title: '趋势',
        categories: 'A2:A4',
        series: [{ name: '数值', values: 'B2:B4' }],
        anchor: { from: 'E2', to: 'L16' },
      }],
    }],
  });
  const out = path.join(dir, 'line.xlsx');
  const made = run(['make', '--spec', spec, '--out', out, '--force']);
  assert.equal(made.status, 0, made.text);
  const chart = part(out, 'xl/charts/chart1.xml');
  // CT_LineSer puts `smooth` after `val`; earlier in the sequence means Excel
  // offers to repair the workbook.
  assert.match(chart, /<\/c:val><c:smooth val="0"\/><\/c:ser>/, 'smooth follows val inside the series');
  assert.doesNotMatch(chart, /<c:smooth val="0"\/><c:marker>/, 'smooth must not precede the marker');
});

test('chart series and grid follow the theme palette', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const { tokens } = await loadTokens();
  const spec = await writeSpec(dir, { designTheme: 'academic', sheets: [CHART_SHEET] });
  const out = path.join(dir, 'chart.xlsx');
  const made = run(['make', '--spec', spec, '--out', out, '--force']);
  assert.equal(made.status, 0, made.text);
  const chart = part(out, 'xl/charts/chart1.xml');
  assert.ok(chart.includes(tokens.themes.academic.chart.series[0]), 'series colour comes from the theme');
  assert.ok(chart.includes(tokens.themes.academic.chart.grid), 'gridline colour comes from the theme');
});

test('an unthemed workbook keeps the old defaults', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const spec = await writeSpec(dir, { sheets: [CHART_SHEET] });
  const out = path.join(dir, 'plain.xlsx');
  const made = run(['make', '--spec', spec, '--out', out, '--force']);
  assert.equal(made.status, 0, made.text);
  assert.equal(made.json.theme, undefined, 'no theme claim on the neutral path');
  assert.doesNotMatch(part(out, 'xl/worksheets/sheet1.xml'), /tabColor/);
  const chart = part(out, 'xl/charts/chart1.xml');
  assert.ok(chart.includes('4472C4'), 'the default series colour is unchanged');
  assert.doesNotMatch(chart, /majorGridlines><c:spPr>/, 'default gridlines stay theme-free');
});

test('--design-theme is accepted on the CLI and unknown names are refused', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'cli.xlsx');
  const made = run(['make', '--title', '门诊统计', '--markdown', path.join(dir, 'missing.md'),
    '--design-theme', 'clinical', '--out', out]);
  // The markdown file is missing on purpose: the theme name must be resolved
  // before the run fails, and the error must not be about the theme.
  assert.match(made.text, /missing\.md|ENOENT/, made.text);

  const markdown = path.join(dir, 'table.md');
  await writeFile(markdown, '| 类别 | 人数 |\n| --- | --- |\n| 急诊 | 12 |\n');
  const ok = run(['make', '--title', '门诊统计', '--markdown', markdown,
    '--design-theme', 'clinical', '--out', out]);
  assert.equal(ok.status, 0, ok.text);
  assert.equal(ok.json.theme?.id, 'clinical');

  const bad = run(['make', '--title', 't', '--body', 'b', '--design-theme', '不存在',
    '--out', path.join(dir, 'bad.xlsx')]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.text, /未知主题/);
  for (const label of ['临床晨光', '青黛循证', '宣纸病案']) {
    assert.ok(bad.text.includes(label), `the error should list ${label}`);
  }

  const ambiguous = run(['make', '--title', 't', '--body', 'b', '--theme', 'clinical',
    '--out', path.join(dir, 'ambiguous.xlsx')]);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.text, /--theme is ambiguous/);
});

test('a themed workbook still passes deliver', { skip: SKIP }, async (t) => {
  const dir = await tempDir(t);
  const spec = await writeSpec(dir, { designTheme: 'trauma', sheets: [CHART_SHEET] });
  const out = path.join(dir, 'deliver.xlsx');
  const made = run(['make', '--spec', spec, '--out', out, '--force']);
  assert.equal(made.status, 0, made.text);
  const requirements = path.join(dir, 'requirements.json');
  await writeFile(requirements, JSON.stringify({
    requiredSheets: ['数据'],
    requiredTables: [{ sheet: '数据', minCount: 1 }],
    requiredNativeCharts: [{
      sheet: '数据', type: 'column', minPoints: 2, sourceRanges: ['A2:A3', 'B2:B3'],
    }],
  }));
  const delivered = run(['deliver', '--input', out, '--out', path.join(dir, 'final.xlsx'),
    '--qa-dir', path.join(dir, 'qa'), '--requirements', requirements]);
  assert.notEqual(delivered.status, 3, delivered.text);
});
