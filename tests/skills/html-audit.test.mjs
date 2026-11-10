import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const auditScript = path.join(repo, 'skills/frontend-slides/scripts/html_audit.py');
const htmlScript = path.join(repo, 'skills/frontend-slides/scripts/html.sh');
const buildScript = path.join(repo, 'skills/frontend-slides/scripts/build-theme-css.mjs');
const themesCssFile = path.join(repo, 'skills/frontend-slides/assets/themes/pd-themes.css');
const fixtures = path.join(repo, 'tests/skills/fixtures/html');
const python = process.env.PILOTDECK_TEST_PYTHON ?? 'python3';

function audit(file, ...extra) {
  const result = spawnSync(python, [auditScript, file, ...extra], { encoding: 'utf8' });
  assert.ok(result.stdout, `audit produced no output: ${result.stderr}`);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

function codes(report) {
  return report.issues.map((item) => item.code);
}

test('pd-themes.css matches the bundled tokens', () => {
  const result = spawnSync('node', [buildScript, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('archive keeps the serif heading role in the generated CSS', async () => {
  const css = await readFile(themesCssFile, 'utf8');
  const block = css.match(/html\[data-pd-theme="archive"\] \{([^}]*)\}/)?.[1] ?? '';
  assert.match(block, /--pd-font-heading: "Noto Serif SC"/);
  assert.match(block, /--pd-font-body: "Noto Serif SC"/);
  assert.equal((css.match(/html\[data-pd-theme="[a-z]+"\] \{/g) ?? []).length, 6,
    'one token block per public theme (component rules use a descendant selector)');
});

test('signature components follow the per-theme surface tokens', async () => {
  const css = await readFile(themesCssFile, 'utf8');
  const rule = (theme, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`html\\[data-pd-theme="${theme}"\\] ${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  };
  // academic: solid-band masthead, primary-fill table header
  assert.match(rule('academic', '.pd-masthead'), /background: var\(--pd-primary\)/);
  assert.match(rule('academic', '.pd-section-marker'), /border-left: 2px solid var\(--pd-primary\)/);
  // archive: hairline masthead, ink-rule table header, hairline-box callout
  assert.match(rule('archive', '.pd-masthead'), /border-top: 1px solid var\(--pd-rule\)/);
  assert.match(rule('archive', '.pd-table thead th'), /border-bottom: 2px solid var\(--pd-ink\)/);
  assert.match(rule('archive', '.pd-callout'), /border: 1px solid var\(--pd-rule\)/);
  // edu: dot marker + rounded card, no masthead/footer decoration
  assert.match(rule('edu', '.pd-section-marker'), /display: flex/);
  assert.match(rule('edu', '.pd-callout'), /border-radius: 12px/);
  assert.equal(rule('edu', '.pd-masthead'), '', 'edu opts out of the masthead band');
  assert.equal(rule('edu', '.pd-footer'), '', 'edu opts out of the footer rule');
  // imaging panels only exist where the palette asks for a dark plate
  assert.match(rule('clinical', '.pd-imaging'), /background: var\(--pd-primary\)/);
  assert.equal(rule('archive', '.pd-imaging'), '');
  // the stamp is theme-independent and uses the accent role
  assert.match(css, /\.pd-stamp\{[^}]*color:var\(--pd-accent\)/);
});

test('html.sh themes lists the six themes with their surface slots', () => {
  const result = spawnSync('bash', [htmlScript, 'themes'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'ok');
  assert.deepEqual(payload.themes.map((item) => item.id),
    ['clinical', 'academic', 'trauma', 'archive', 'edu', 'mono']);
  // D1: the default theme is clinical. HTML has no generator, so the skill
  // text carries the default; this listing is where it stays machine-checkable.
  assert.equal(payload.default, 'clinical');
  assert.deepEqual(payload.themes.filter((item) => item.default).map((item) => item.id),
    ['clinical']);
  for (const item of payload.themes) {
    assert.ok(item.surface?.masthead, `${item.id} must expose its masthead treatment`);
  }
});

test('the skill text tells the model to default to the clinical theme', async () => {
  const skill = await readFile(path.join(repo, 'skills/frontend-slides/SKILL.md'), 'utf8');
  const themesDoc = await readFile(path.join(repo, 'skills/frontend-slides/references/themes.md'), 'utf8');
  assert.match(skill, /默认就用 `clinical`/);
  assert.match(skill, /data-pd-theme="clinical"/);
  assert.match(themesDoc, /未指定时一律用 `clinical`/);
});

test('a themed page with the generated CSS passes every fact check', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'html-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  const template = await readFile(path.join(fixtures, 'themed.template.html'), 'utf8');
  const css = await readFile(themesCssFile, 'utf8');
  await cp(path.join(fixtures, 'assets/photo.png'), path.join(dir, 'assets/photo.png'));
  for (const theme of ['clinical', 'academic', 'trauma', 'archive', 'edu', 'mono']) {
    const html = template
      .replace('data-pd-theme="academic"', `data-pd-theme="${theme}"`)
      .replace('/*__PD_THEMES__*/', css);
    await writeFile(path.join(dir, 'index.html'), html);
    const { status, report } = audit(dir);
    assert.equal(report.status, 'ok', `${theme}: ${JSON.stringify(report.issues)}`);
    assert.equal(status, 0);
    assert.equal(report.theme.id, theme);
    assert.equal(report.theme.scope, 'selector');
    assert.deepEqual(report.theme.mismatched, []);
    assert.equal(report.visual_acceptance, 'not_performed');
  }
});

test('inlined theme CSS without data-pd-theme is flagged, not silently passed', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'html-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  const template = await readFile(path.join(fixtures, 'themed.template.html'), 'utf8');
  const css = await readFile(themesCssFile, 'utf8');
  await cp(path.join(fixtures, 'assets/photo.png'), path.join(dir, 'assets/photo.png'));
  // Drop the attribute but keep the tokens: every selector is scoped to
  // html[data-pd-theme="..."], so nothing would paint.
  const html = template
    .replace(' data-pd-theme="academic"', '')
    .replace('/*__PD_THEMES__*/', css);
  await writeFile(path.join(dir, 'index.html'), html);
  const { report } = audit(dir);
  assert.ok(codes(report).includes('theme-attribute-missing'), JSON.stringify(report.issues));
  assert.equal(report.theme?.declared, null);
});

test('offline violations are reported as errors', () => {
  const { status, report } = audit(path.join(fixtures, 'bad-external.html'));
  assert.equal(status, 1);
  assert.equal(report.status, 'error');
  const found = codes(report);
  assert.ok(found.includes('external-resource'));
  assert.ok(found.includes('external-css-resource'));
  assert.ok(found.includes('external-script'));
  assert.ok(found.includes('external-link'));
  assert.ok(found.includes('css-import'));
});

test('structure violations cover ids, tags, alt, empty sections and file URLs', () => {
  const { report } = audit(path.join(fixtures, 'bad-structure.html'));
  const found = codes(report);
  for (const code of ['duplicate-id', 'unclosed-tag', 'img-alt-missing',
    'empty-section', 'file-url', 'absolute-resource']) {
    assert.ok(found.includes(code), `missing ${code}: ${found}`);
  }
  assert.equal(report.document.lang, null);
  assert.equal(report.document.charset, null);
});

test('references outside the page directory are rejected', () => {
  const { report } = audit(path.join(fixtures, 'outside.html'));
  assert.ok(codes(report).includes('resource-outside-page'));
});

test('a base tag is rejected because it breaks relative paths', () => {
  const { report } = audit(path.join(fixtures, 'base-tag.html'));
  assert.ok(codes(report).includes('base-tag'));
});

test('executable payloads, redirects and inline handlers are reported', () => {
  const { report } = audit(path.join(fixtures, 'unsafe.html'));
  const found = codes(report);
  for (const code of ['javascript-url', 'unsafe-data-url', 'external-redirect',
    'inline-event-handler', 'external-form-action', 'missing-viewport']) {
    assert.ok(found.includes(code), `missing ${code}: ${found}`);
  }
});

test('special characters parse cleanly and a viewport removes the warning', () => {
  const { report } = audit(path.join(fixtures, 'special-chars.html'));
  assert.equal(report.status, 'ok', JSON.stringify(report.issues));
  assert.equal(report.document.lang, 'zh-CN');
});

test('unknown themes and drifted tokens are rejected', async (t) => {
  const unknown = audit(path.join(fixtures, 'bad-theme.html')).report;
  assert.ok(codes(unknown).includes('unknown-theme'));

  const mismatch = audit(path.join(fixtures, 'mismatch-theme.html')).report;
  const detail = mismatch.issues.find((item) => item.code === 'theme-token-mismatch');
  assert.equal(detail.detail.token, '--pd-primary');
  assert.equal(detail.detail.expected, '#12404F');
  assert.equal(detail.detail.actual, '#FF00FF');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'html-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), `<!doctype html>
<html lang="zh-CN" data-pd-theme="mono"><head><meta charset="utf-8">
<title>缺令牌</title></head><body><h1>缺令牌</h1><p>正文</p></body></html>`);
  const missing = audit(dir).report;
  assert.ok(codes(missing).includes('theme-token-missing'));
  assert.ok(missing.theme.missing.includes('--pd-primary'));

  await writeFile(path.join(dir, 'index.html'), `<!doctype html>
<html lang="zh-CN" data-pd-theme="青黛循证"><head><meta charset="utf-8">
<title>别名</title></head><body><h1>别名</h1><p>正文</p></body></html>`);
  const alias = audit(dir).report;
  const aliasIssue = alias.issues.find((item) => item.code === 'theme-id-required');
  assert.equal(aliasIssue.detail.expected, 'academic');
});

test('audit output is deterministic for the same file', () => {
  const first = audit(path.join(fixtures, 'bad-structure.html')).report;
  const second = audit(path.join(fixtures, 'bad-structure.html')).report;
  const strip = (report) => ({ ...report, timing_ms: undefined });
  assert.deepEqual(strip(first), strip(second));
  assert.ok(first.timing_ms.total >= 0);
});

test('layout estimates only touch marked blocks and never change the file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'html-estimate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'index.html');
  const headers = Array.from({ length: 20 }, (_, index) => `<th>列${index + 1}</th>`).join('');
  const cells = Array.from({ length: 20 }, (_, index) => `<td>${index + 1}</td>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>静态预算</title></head><body>
<h1>静态预算</h1>
<section data-pd-block="section"><p>${'字'.repeat(6000)}</p></section>
<table data-pd-block="table"><tr>${headers}</tr><tr>${cells}</tr></table>
<div data-pd-block="figure-grid" data-pd-columns="8"><p>图组</p></div>
<section data-pd-block="section"><p>短段落。</p></section>
</body></html>`;
  await writeFile(file, html);
  const before = await readFile(file, 'utf8');

  const withEstimates = audit(file).report;
  const found = codes(withEstimates);
  for (const code of ['estimate-tall-block', 'estimate-wide-table', 'estimate-figure-overflow']) {
    assert.ok(found.includes(code), `missing ${code}: ${found}`);
  }
  assert.equal(withEstimates.estimates.enabled, true);
  assert.equal(withEstimates.estimates.blocks.length, 4);
  assert.equal(withEstimates.status, 'warning');

  const without = audit(file, '--no-estimate').report;
  assert.equal(without.estimates.enabled, false);
  assert.equal(without.status, 'ok', JSON.stringify(without.issues));
  assert.ok(!codes(without).some((code) => code.startsWith('estimate-')));
  assert.equal(await readFile(file, 'utf8'), before);
});
