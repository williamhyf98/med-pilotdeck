// 设计档 A：调色板之外的自定义强调色。
// 规则：可以自定义强调位（文字 / 色条 / 表头底 / 边框），但必须过对比度门禁；
// 语义四色（success/warning/danger/info）保持由 design-tokens.json 决定。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  contrastRatio,
  ensureContrast,
  mixHex,
  normalizeHex,
} from '../../skills/_shared/tokens.mjs';
import { resolveSlideAccent, tokensForSlide } from '../../skills/pptx/scripts/lib/slide-style.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.PILOTDECK_TEST_PYTHON ?? 'python3';
const docxScript = path.join(repo, 'skills/docx/scripts/docx.sh');
const pdfScript = path.join(repo, 'skills/pdf/scripts/pdf.sh');
const xlsxScript = path.join(repo, 'skills/spreadsheets/scripts/spreadsheet.sh');

function run(script, args, cwd = repo) {
  const result = spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  let json = null;
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const candidates = [
    result.stdout,
    ...text.split('\n').filter((line) => line.trim().startsWith('{')).reverse(),
  ];
  for (const candidate of candidates) {
    try {
      json = JSON.parse(candidate);
      break;
    } catch {
      json = null;
    }
  }
  return { status: result.status, json, text };
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'accent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('contrast helpers agree between Node and Python', () => {
  const code = [
    'import importlib.util, json, pathlib',
    `p = pathlib.Path(${JSON.stringify(path.join(repo, 'skills/_shared/tokens.py'))})`,
    'spec = importlib.util.spec_from_file_location("t", p)',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'print(json.dumps({',
    '  "blackWhite": m.contrast_ratio("000000", "FFFFFF"),',
    '  "accent": m.contrast_ratio("1F5FA9", "FFFFFF"),',
    '  "mix": m.mix_hex("B4552D"),',
    '  "normalize": m.normalize_hex("#1f5fa9"),',
    '}))',
  ].join('\n');
  const other = JSON.parse(execFileSync(python, ['-c', code], { encoding: 'utf8' }));
  assert.equal(normalizeHex('#1f5fa9'), '1F5FA9');
  assert.equal(other.normalize, '1F5FA9');
  assert.equal(contrastRatio('000000', 'FFFFFF'), 21);
  assert.ok(Math.abs(other.blackWhite - 21) < 1e-9);
  assert.ok(Math.abs(contrastRatio('1F5FA9', 'FFFFFF') - other.accent) < 1e-9);
  assert.equal(mixHex('B4552D'), other.mix);
});

test('ensureContrast rejects washed-out accents and suggests a usable one', () => {
  assert.equal(ensureContrast('#1F5FA9', 'FFFFFF', 4.5), '1F5FA9');
  assert.throws(
    () => ensureContrast('#FFF200', 'FFFFFF', 4.5, 'accent'),
    /对比度只有 1\.\d+:1/,
  );
});

test('PPTX: a hex accent works on light slides and is gated on readability', () => {
  const tokens = { colors: { paper: 'FFFFFF', accent: 'B4552D', onDark: 'FFFFFF', navy: '12404F' } };
  assert.equal(resolveSlideAccent(tokens, '#1F5FA9'), '1F5FA9');
  const styled = tokensForSlide(tokens, { accent: '#1F5FA9' });
  assert.equal(styled.colors.accent, '1F5FA9');
  assert.throws(
    () => tokensForSlide(tokens, { accent: '#FFF200' }),
    /at least 3:1 contrast/,
  );
  // 深底页沿用原有逻辑：自动提亮到看得清，而不是报错。
  const dark = tokensForSlide({ ...tokens, colors: { ...tokens.colors, navy: '101828' } },
    { accent: '#1F5FA9', tone: 'dark' });
  assert.ok(contrastRatio(dark.colors.accent, dark.colors.paper) >= 3.4);
});

test('DOCX: custom accent is accepted, a low-contrast one is refused', async (t) => {
  const dir = await tempDir(t);
  const okSpec = path.join(dir, 'ok.json');
  await writeFile(okSpec, JSON.stringify({
    style_policy: { mode: 'builtin', template: 'neutral-document-v1' },
    content: [{
      type: 'table',
      headers: ['A', 'B'],
      rows: [['1', '2']],
      header_fill: '#1F4E79',
      header_text_color: '#FFFFFF',
    }],
  }));
  const okOut = path.join(dir, 'ok.docx');
  const made = run(docxScript, ['make', '--spec', okSpec, '--out', okOut], dir);
  assert.equal(made.status, 0, made.text);
  const xml = execFileSync('unzip', ['-p', okOut, 'word/document.xml'], { encoding: 'utf8' });
  assert.match(xml, /1F4E79/, 'the custom header fill reaches the document');

  const badSpec = path.join(dir, 'bad.json');
  await writeFile(badSpec, JSON.stringify({
    style_policy: { mode: 'builtin', template: 'neutral-document-v1' },
    content: [{
      type: 'table',
      headers: ['A'],
      rows: [['1']],
      header_fill: '#FFEEDD',
      header_text_color: '#FFFFFF',
    }],
  }));
  const bad = run(docxScript, ['make', '--spec', badSpec, '--out', path.join(dir, 'bad.docx')], dir);
  assert.equal(bad.json?.status, 'error', bad.text);
  assert.equal(bad.json?.code, 'style-contrast-too-low', bad.text);
});

test('PDF: a hex accent role resolves, a washed-out one is refused', async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '自定义强调色',
    accent: '#1F5FA9',
    sections: [{ heading: '小节', body: '正文。' }],
  }));
  const out = path.join(dir, 'doc.pdf');
  const made = run(pdfScript, ['make', '--spec', spec, '--out', out], dir);
  assert.equal(made.status, 0, made.text);
  assert.doesNotMatch(made.text, /must be one of/);

  await writeFile(spec, JSON.stringify({
    title: '浅色陷阱',
    accent: '#FFF200',
    sections: [{ heading: '小节', body: '正文。' }],
  }));
  const bad = run(pdfScript, ['make', '--spec', spec, '--out', path.join(dir, 'bad.pdf')], dir);
  assert.notEqual(bad.status, 0, bad.text);
  assert.match(bad.text, /对比度只有/);
});

test('XLSX: a hex role reaches conditional formatting, a washed-out one is refused', async (t) => {
  const ready = run(xlsxScript, ['check']).json;
  if (!(ready?.status === 'ok' || ready?.usable === true)) {
    t.skip('spreadsheet runtime not installed');
    return;
  }
  const dir = await tempDir(t);
  const sheet = (role) => ({
    sheets: [{
      name: '数据',
      headers: ['类别', '人数'],
      rows: [['急诊', 30]],
      conditionalFormatting: [{
        range: 'B2:B2',
        rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [20], role }],
      }],
    }],
  });
  const okSpec = path.join(dir, 'ok.json');
  await writeFile(okSpec, JSON.stringify(sheet('#1F5FA9')));
  const okOut = path.join(dir, 'ok.xlsx');
  const made = run(xlsxScript, ['make', '--spec', okSpec, '--out', okOut], dir);
  assert.equal(made.status, 0, made.text);
  const styles = execFileSync('unzip', ['-p', okOut, 'xl/styles.xml'], { encoding: 'utf8' });
  assert.match(styles, /FF1F5FA9/);

  const badSpec = path.join(dir, 'bad.json');
  await writeFile(badSpec, JSON.stringify(sheet('#FFF200')));
  const bad = run(xlsxScript, ['make', '--spec', badSpec, '--out', path.join(dir, 'bad.xlsx')], dir);
  assert.notEqual(bad.status, 0, bad.text);
  assert.match(bad.text, /4\.5:1/);
});
