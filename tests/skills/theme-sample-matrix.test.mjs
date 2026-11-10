// T5.3: script-level regression matrix — six themes x every format.
//
// Every combination builds one small synthetic report from material authored
// in this file (no third-party assets), then checks that the theme actually
// reached the package instead of silently falling back to the neutral look.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrappers = {
  pptx: path.join(repo, 'skills/pptx/scripts/pptx.sh'),
  docx: path.join(repo, 'skills/docx/scripts/docx.sh'),
  xlsx: path.join(repo, 'skills/spreadsheets/scripts/spreadsheet.sh'),
  pdf: path.join(repo, 'skills/pdf/scripts/pdf.sh'),
  html: path.join(repo, 'skills/frontend-slides/scripts/html.sh'),
  diagram: path.join(repo, 'skills/diagram-maker/scripts/diagram.sh'),
};

const tokens = JSON.parse(
  await readFile(path.join(repo, 'skills/_shared/design-tokens.json'), 'utf8'),
);
const THEMES = Object.fromEntries(
  Object.entries(tokens.themes)
    .filter(([, theme]) => theme.status === 'stable')
    .map(([id, theme]) => [id, { label: theme.label, primary: theme.colors.primary.toUpperCase() }]),
);

const env = {
  ...process.env,
  PATH: `${path.join(repo, '.runtime/node/bin')}:${process.env.PATH ?? ''}`,
  XDG_CACHE_HOME: path.join(repo, '.runtime/cache/xdg'),
  PILOTDECK_OFFICE_RENDERER_URL: '',
};
delete env.PILOTDECK_WORK_DIR;

function run(wrapper, args) {
  const result = spawnSync('bash', [wrapper, ...args], { env, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const toolReady = (name) => run(wrappers[name], ['check']).status === 0;

const SAMPLES = {
  pptx: { ready: toolReady('pptx'), build: buildPptx },
  docx: { ready: toolReady('docx'), build: buildDocx },
  xlsx: { ready: toolReady('xlsx'), build: buildXlsx },
  pdf: { ready: toolReady('pdf'), build: buildPdf },
  html: { ready: toolReady('html'), audit: auditHtml },
  diagram: { ready: toolReady('diagram'), build: buildDiagram },
};

const MARKDOWN = [
  '# 病例摘要',
  '',
  '患者男性，58 岁，因胸痛三小时入院。',
  '',
  '## 检查结果',
  '',
  '肌钙蛋白升高，心电图 ST 段压低。',
  '',
  '| 指标 | 数值 |',
  '| --- | --- |',
  '| 肌钙蛋白 | 升高 |',
  '| 白细胞 | 12.3 |',
  '',
  '## 结论',
  '',
  '建议留观并复查心肌酶。',
  '',
].join('\n');

async function buildPptx(dir, theme) {
  const markdown = path.join(dir, `pptx-${theme}.md`);
  await writeFile(markdown, MARKDOWN);
  const out = path.join(dir, `pptx-${theme}.pptx`);
  // PPTX takes --theme; the other three take --design-theme.
  return { out, result: run(wrappers.pptx, ['make', '--markdown', markdown, '--theme', theme, '--out', out, '--force']) };
}

async function buildDocx(dir, theme) {
  const spec = path.join(dir, `docx-${theme}.json`);
  await writeFile(spec, JSON.stringify({
    metadata: { title: '病例摘要' },
    content: [
      { type: 'heading', level: 1, text: '病例摘要' },
      { type: 'paragraph', text: '患者男性，58 岁，因胸痛三小时入院。' },
      { type: 'checklist', items: ['已完成心电图', '已抽血'], checked: [true, false] },
      { type: 'table', headers: ['指标', '数值'], rows: [['肌钙蛋白', '升高'], ['白细胞', '12.3']] },
    ],
  }));
  const out = path.join(dir, `docx-${theme}.docx`);
  return { out, result: run(wrappers.docx, ['make', '--spec', spec, '--design-theme', theme, '--out', out, '--force']) };
}

async function buildXlsx(dir, theme) {
  const spec = path.join(dir, `xlsx-${theme}.json`);
  await writeFile(spec, JSON.stringify({
    sheets: [{
      name: '随访',
      headers: ['项目', '数值'],
      rows: [['肌钙蛋白', '升高'], ['白细胞', 12.3]],
    }],
  }));
  const out = path.join(dir, `xlsx-${theme}.xlsx`);
  return { out, result: run(wrappers.xlsx, ['make', '--spec', spec, '--design-theme', theme, '--out', out, '--force']) };
}

async function buildPdf(dir, theme) {
  const markdown = path.join(dir, `pdf-${theme}.md`);
  await writeFile(markdown, MARKDOWN);
  const out = path.join(dir, `pdf-${theme}.pdf`);
  return { out, result: run(wrappers.pdf, ['make', '--markdown', markdown, '--design-theme', theme, '--out', out, '--force']) };
}

// HTML has no generator: the skill text tells the model to inline the token CSS
// and set data-pd-theme. The regression builds that page itself and audits it.
const HTML_TEMPLATE = [
  '<!doctype html>',
  '<html lang="zh-CN" data-pd-theme="__THEME__">',
  '<head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>病例摘要</title>',
  '<style>__TOKENS__',
  'body{margin:0;background:var(--pd-paper);color:var(--pd-ink);font-family:var(--pd-font-body)}',
  'main{max-width:960px;margin:0 auto;padding:32px 24px}',
  'h1,h2{font-family:var(--pd-font-heading);color:var(--pd-primary)}',
  'th{background:var(--pd-primary);color:var(--pd-on-primary);text-align:left}',
  'th,td{padding:8px 10px;border:1px solid var(--pd-rule)}',
  '</style></head>',
  '<body><main>',
  '<h1>病例摘要</h1>',
  '<p>患者男性，58 岁，因胸痛三小时入院。</p>',
  '<h2>检查结果</h2>',
  '<table><thead><tr><th>指标</th><th>数值</th></tr></thead>',
  '<tbody><tr><td>肌钙蛋白</td><td>升高</td></tr></tbody></table>',
  '</main></body></html>',
].join('\n');

async function auditHtml(dir, theme) {
  const css = await readFile(
    path.join(repo, 'skills/frontend-slides/assets/themes/pd-themes.css'), 'utf8');
  const out = path.join(dir, `html-${theme}.html`);
  await writeFile(out, HTML_TEMPLATE.replace('__THEME__', theme).replace('__TOKENS__', css));
  return { out, result: run(wrappers.html, ['audit', out]) };
}

async function buildDiagram(dir, theme) {
  const out = path.join(dir, `diagram-${theme}.svg`);
  return {
    out,
    result: run(wrappers.diagram, ['make', '--title', '随访流程', '--body', '入院 → 检查 → 结论',
      '--design-theme', theme, '--out', out, '--force']),
  };
}

function docxDocument(file) {
  return execFileSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8' });
}

test('six themes reach all six formats', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'theme-matrix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const covered = [];
  for (const [format, sample] of Object.entries(SAMPLES)) {
    if (!sample.ready) continue;
    for (const [theme, expected] of Object.entries(THEMES)) {
      const { out, result } = await (sample.build ?? sample.audit)(dir, theme);
      assert.equal(result.status, 0, `${format}/${theme}: ${result.text}`);
      const json = result.json ?? {};
      assert.equal(json.status ?? 'ok', 'ok', `${format}/${theme}: ${result.text}`);

      if (format === 'pptx') {
        assert.equal(json.theme, theme, `pptx/${theme}: theme id`);
        assert.equal(json.themeLabel, expected.label, `pptx/${theme}: Chinese label`);
        assert.equal(json.audit?.counts?.errors, 0, `pptx/${theme}: audit errors`);
      } else if (format === 'docx') {
        const document = docxDocument(out);
        assert.ok(
          document.toUpperCase().includes(expected.primary),
          `docx/${theme}: heading should carry the ${expected.primary} primary colour`,
        );
        assert.equal(json.audit?.status, 'ok', `docx/${theme}: audit`);
      } else if (format === 'html') {
        assert.equal(json.theme?.id, theme, `html/${theme}: theme id`);
        assert.deepEqual(json.theme?.mismatched, [], `html/${theme}: token drift`);
        assert.equal(json.counts?.errors, 0, `html/${theme}: audit errors`);
      } else if (format === 'diagram') {
        assert.equal(json.designTheme?.id, theme, `diagram/${theme}: theme id`);
        assert.equal(json.designTheme?.label, expected.label, `diagram/${theme}: Chinese label`);
        assert.equal(json.warnings?.length, 0, `diagram/${theme}: warnings`);
      } else {
        assert.equal(json.theme?.id, theme, `${format}/${theme}: theme id`);
        assert.equal(json.theme?.label, expected.label, `${format}/${theme}: Chinese label`);
      }
      covered.push(`${format}/${theme}`);
    }
  }

  if (covered.length === 0) return t.skip('no skill runtime available');
  assert.ok(covered.length >= 6, `the matrix should cover several formats, got ${covered.join(', ')}`);
});

test('the archive theme embeds the bundled serif face in PDF', async (t) => {
  if (!SAMPLES.pdf.ready) return t.skip('pdf runtime not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'theme-matrix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { out, result } = await buildPdf(dir, 'archive');
  assert.equal(result.status, 0, result.text);
  const inspectOut = path.join(dir, 'inspect.json');
  const inspected = run(wrappers.pdf, ['inspect', '--input', out, '--out', inspectOut]);
  assert.equal(inspected.status, 0, inspected.text);
  const details = JSON.parse(await readFile(inspectOut, 'utf8'));
  assert.ok(
    details.fonts.some((font) => /NotoSerifSC/.test(font.name) && font.embedded),
    'archive is the serif theme and must embed the serif face',
  );
});
