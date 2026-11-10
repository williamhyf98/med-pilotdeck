// T3a.2: adapters must map reports produced by the real DOCX/PPTX/XLSX
// deliver gates into the shared QA report without touching the legacy files.
//
// These tests run the actual producers, so they are skipped when a skill's
// pinned runtime is not installed in this environment (the offline bundle
// ships it; a bare dev checkout may not).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adaptScript = path.join(repo, 'skills/_shared/qa/adapters/adapt.py');
const protocolScript = path.join(repo, 'skills/_shared/qa/qa_protocol.py');
const htmlScript = path.join(repo, 'skills/frontend-slides/scripts/html.sh');
const diagramScript = path.join(repo, 'skills/diagram-maker/scripts/diagram.sh');
const python = process.env.PILOTDECK_TEST_PYTHON ?? 'python3';

function rendererUrl() {
  if (process.env.PILOTDECK_OFFICE_RENDERER_URL) return process.env.PILOTDECK_OFFICE_RENDERER_URL;
  try {
    const text = readFileSync(path.join(repo, 'scripts/config.env'), 'utf8');
    return text.match(/^PILOTDECK_OFFICE_RENDERER_URL=(.*)$/m)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

const env = { ...process.env, PILOTDECK_OFFICE_RENDERER_URL: rendererUrl() };

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 240_000,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const RUNTIME_SCRIPTS = {
  docx: 'skills/docx/scripts/docx.sh',
  pptx: 'skills/pptx/scripts/pptx.sh',
  pdf: 'skills/pdf/scripts/pdf.sh',
  spreadsheet: 'skills/spreadsheets/scripts/spreadsheet.sh',
};

function runtime(skill) {
  const script = path.join(repo, RUNTIME_SCRIPTS[skill]);
  const result = run('bash', [script, 'check']);
  const ready = result.json?.status === 'ok' || result.json?.usable === true;
  const renderer = Boolean(result.json?.render_available);
  return { ready, renderer, detail: result.json ?? result.text };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function workspace(t, name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `qa-adapter-${name}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function adapt(skill, args) {
  return run(python, [adaptScript, skill, ...args, '--now', '2026-11-09T00:00:00+00:00']);
}

function officeRendererMissing(result) {
  return /Office Renderer (is not configured|is unavailable|returned HTTP)/i.test(result.text);
}

const docxRuntime = runtime('docx');
const pptxRuntime = runtime('pptx');
const pdfRuntime = runtime('pdf');
const xlsxRuntime = runtime('spreadsheet');

test('DOCX preflight adapts into the unified report', {
  skip: docxRuntime.ready ? false : `docx runtime not installed: ${JSON.stringify(docxRuntime.detail)}`,
}, async (t) => {
  const dir = await workspace(t, 'docx');
  const docx = path.join(dir, 'report.docx');
  const made = run('bash', [path.join(repo, 'skills/docx/scripts/docx.sh'), 'make',
    '--title', '急性心肌梗死病例报告',
    '--body', '患者男性，58岁，因胸痛3小时入院。心电图示ST段抬高，肌钙蛋白升高。行急诊PCI治疗。',
    '--out', docx]);
  assert.equal(made.status, 0, made.text);

  const acceptance = path.join(dir, 'acceptance.json');
  await writeFile(acceptance, JSON.stringify({
    required_text: ['肌钙蛋白'],
    page_count: { min: 1, max: 3 },
    images: { min: 0 },
  }));

  const preflightPath = path.join(dir, 'preflight.json');
  const preflight = run('bash', [path.join(repo, 'skills/docx/scripts/docx.sh'), 'preflight',
    '--input', docx, '--out-dir', path.join(dir, 'render'),
    '--report', preflightPath, '--acceptance', acceptance]);
  if (officeRendererMissing(preflight)) {
    t.skip('Office Renderer unreachable; DOCX preflight cannot render');
    return;
  }
  // A "partial" preflight (visual review still pending) exits non-zero by design.
  assert.ok(preflight.json, preflight.text);
  const preflightReport = JSON.parse(await readFile(preflightPath, 'utf8'));
  assert.equal(preflightReport.status, 'partial', JSON.stringify(preflightReport.checks));
  assert.equal(preflightReport.checks.render, 'passed');
  const pages = preflightReport.render?.pages;
  assert.ok(Number.isInteger(pages) && pages > 0, 'preflight must render at least one page');

  const before = sha256(await readFile(preflightPath));
  const artifactSha = sha256(await readFile(docx));

  await t.test('without a review the visual state is not_performed', async () => {
    const result = adapt('docx', ['--report', preflightPath, '--artifact', docx,
      '--out', path.join(dir, 'qa-report.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed_with_warnings');
    assert.equal(result.json.checks.structural, 'passed');
    assert.equal(result.json.checks.content, 'passed');
    assert.equal(result.json.checks.visual, 'not_performed');

    const report = JSON.parse(await readFile(path.join(dir, 'qa-report.json'), 'utf8'));
    assert.equal(report.artifact.sha256, artifactSha);
    assert.equal(report.legacy.acceptanceDerived, true);
    const derived = JSON.parse(await readFile(path.join(dir, 'acceptance.derived.json'), 'utf8'));
    assert.deepEqual(derived.requirements.text, ['肌钙蛋白']);
    assert.equal(path.basename(derived.derivedFrom.report), 'preflight.json');
    assert.equal(run(python, [protocolScript, 'validate-report',
      path.join(dir, 'qa-report.json')]).status, 0);
  });

  await t.test('a full page review upgrades the report to passed', async () => {
    const review = path.join(dir, 'review.json');
    await writeFile(review, JSON.stringify({
      schema: 'pilotdeck-qa-review/v1',
      artifactSha256: artifactSha,
      pageCount: pages,
      reviewer: 'human',
      pages: Array.from({ length: pages }, (_, index) => ({
        page: index + 1, status: 'passed', notes: `第 ${index + 1} 页版式正常`,
      })),
    }));
    const result = adapt('docx', ['--report', preflightPath, '--artifact', docx,
      '--review', review, '--out', path.join(dir, 'qa-report.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed');
    assert.equal(result.json.checks.visual, 'passed');
  });

  await t.test('a stale review page count is rejected', async () => {
    const review = path.join(dir, 'review-stale.json');
    await writeFile(review, JSON.stringify({
      schema: 'pilotdeck-qa-review/v1',
      artifactSha256: artifactSha,
      pageCount: pages + 1,
      pages: Array.from({ length: pages + 1 }, (_, index) => ({
        page: index + 1, status: 'passed', notes: 'stale',
      })),
    }));
    const result = adapt('docx', ['--report', preflightPath, '--artifact', docx,
      '--review', review, '--out', path.join(dir, 'qa-report.json')]);
    assert.equal(result.status, 1);
    assert.equal(result.json.code, 'review-page-count-mismatch');
  });

  await t.test('missing images stay a delivery gap, not a failure', async () => {
    const strict = path.join(dir, 'acceptance-images.json');
    await writeFile(strict, JSON.stringify({
      required_text: ['肌钙蛋白'], page_count: { min: 1 }, images: { min: 2 },
    }));
    const strictReport = path.join(dir, 'preflight-images.json');
    const strictRun = run('bash', [path.join(repo, 'skills/docx/scripts/docx.sh'), 'preflight',
      '--input', docx, '--out-dir', path.join(dir, 'render-images'),
      '--report', strictReport, '--acceptance', strict]);
    assert.ok(strictRun.json, strictRun.text);
    assert.equal(strictRun.json.status, 'partial', JSON.stringify(strictRun.json.checks));
    const result = adapt('docx', ['--report', strictReport, '--artifact', docx,
      '--out', path.join(dir, 'qa-report-images.json')]);
    assert.equal(result.json.status, 'delivered_with_missing_assets');
    assert.equal(result.json.checks.assets, 'missing');
    assert.equal(result.json.missingAssets, 1);
  });

  assert.equal(sha256(await readFile(preflightPath)), before,
    'the adapter must not rewrite the legacy preflight report');
});

test('PPTX delivery adapts into the unified report', {
  skip: pptxRuntime.ready ? false : `pptx runtime not installed: ${JSON.stringify(pptxRuntime.detail)}`,
}, async (t) => {
  const dir = await workspace(t, 'pptx');
  const deck = path.join(dir, 'deck.pptx');
  const made = run('bash', [path.join(repo, 'skills/pptx/scripts/pptx.sh'), 'make',
    '--title', '病例讨论', '--body', '# 病史\n患者男性，58岁，胸痛3小时。\n\n# 检查\n肌钙蛋白升高。',
    '--out', deck]);
  assert.equal(made.status, 0, made.text);

  const requirements = path.join(dir, 'requirements.json');
  await writeFile(requirements, JSON.stringify({
    slideCount: 2,
    requirements: [
      { id: 'history', label: '既往病史', terms: ['胸痛'] },
      { id: 'lab', label: '实验室检查', terms: ['肌钙蛋白'] },
    ],
  }));
  const qaDir = path.join(dir, 'qa');
  const deliverable = path.join(dir, 'final.pptx');
  const delivered = run('bash', [path.join(repo, 'skills/pptx/scripts/pptx.sh'), 'deliver',
    '--input', deck, '--out', deliverable, '--qa-dir', qaDir,
    '--requirements', requirements, '--require-coverage']);
  assert.equal(delivered.status, 0, delivered.text);

  const deliveryPath = path.join(qaDir, 'delivery.json');
  const deliveryText = await readFile(deliveryPath, 'utf8');
  const deliveryBefore = sha256(Buffer.from(deliveryText));
  const delivery = JSON.parse(deliveryText);
  const slides = delivery.artifact.slideCount;
  const artifactSha = sha256(await readFile(deliverable));

  await t.test('renders are recorded but visual acceptance is not claimed', async () => {
    const result = adapt('pptx', ['--report', deliveryPath, '--artifact', deliverable,
      '--out', path.join(dir, 'qa-report.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed_with_warnings');
    assert.equal(result.json.checks.structural, 'passed');
    assert.equal(result.json.checks.content, 'passed');
    assert.equal(result.json.checks.visual, 'not_performed');
    assert.equal(result.json.summary.renderStatus, delivery.render.status);

    const derived = JSON.parse(await readFile(path.join(dir, 'acceptance.derived.json'), 'utf8'));
    assert.deepEqual(derived.requirements.text, ['既往病史', '实验室检查']);
    assert.deepEqual(derived.requirements.pages, { min: 2, max: 2 });
  });

  await t.test('a per-slide review upgrades the report to passed', async () => {
    const review = path.join(dir, 'review.json');
    await writeFile(review, JSON.stringify({
      schema: 'pilotdeck-qa-review/v1',
      artifactSha256: artifactSha,
      pageCount: slides,
      reviewer: 'human',
      pages: Array.from({ length: slides }, (_, index) => ({
        page: index + 1, status: 'passed', notes: `幻灯片 ${index + 1} 无遮挡`,
      })),
    }));
    const result = adapt('pptx', ['--report', deliveryPath, '--artifact', deliverable,
      '--review', review, '--out', path.join(dir, 'qa-report.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed');
  });

  await t.test('a changed artifact invalidates the delivery record', async () => {
    const changed = path.join(dir, 'changed.pptx');
    await copyFile(deliverable, changed);
    await appendFile(changed, 'changed');
    const result = adapt('pptx', ['--report', deliveryPath, '--artifact', changed,
      '--out', path.join(dir, 'qa-report-changed.json')]);
    assert.equal(result.status, 1);
    assert.equal(result.json.status, 'failed');
    assert.equal(result.json.checks.structural, 'failed');
    const report = JSON.parse(await readFile(path.join(dir, 'qa-report-changed.json'), 'utf8'));
    assert.ok(report.issues.some((item) => item.code === 'artifact-changed-since-delivery'));
  });

  assert.equal(sha256(await readFile(deliveryPath)), deliveryBefore,
    'the adapter must not rewrite delivery.json');
});

test('PDF delivery adapts into the unified report', {
  skip: pdfRuntime.ready ? false : `pdf runtime not installed: ${JSON.stringify(pdfRuntime.detail)}`,
}, async (t) => {
  const dir = await workspace(t, 'pdf');
  const pdfScript = path.join(repo, 'skills/pdf/scripts/pdf.sh');
  const pdf = path.join(dir, 'report.pdf');
  const made = run('bash', [pdfScript, 'make',
    '--title', '急性心肌梗死病例报告',
    '--body', '患者男性，58岁，胸痛3小时入院。肌钙蛋白升高，行急诊PCI治疗。',
    '--out', pdf]);
  assert.equal(made.status, 0, made.text);

  const reportPath = path.join(dir, 'delivery.json');
  const delivered = run('bash', [pdfScript, 'deliver', '--input', pdf,
    '--require-text', '肌钙蛋白', '--min-pages', '1', '--report', reportPath]);
  assert.equal(delivered.status, 0, delivered.text);
  const delivery = JSON.parse(await readFile(reportPath, 'utf8'));
  const artifactSha = sha256(await readFile(pdf));
  const pages = delivery.artifact.pageCount;
  assert.equal(delivery.artifact.sha256, artifactSha);

  await t.test('requirements come from the delivery coverage checks', async () => {
    const result = adapt('pdf', ['--report', reportPath, '--artifact', pdf,
      '--out', path.join(dir, 'qa-report.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed_with_warnings');
    assert.equal(result.json.checks.structural, 'passed');
    assert.equal(result.json.checks.content, 'passed');
    assert.equal(result.json.checks.visual, 'not_performed');
    const derived = JSON.parse(await readFile(path.join(dir, 'acceptance.derived.json'), 'utf8'));
    assert.deepEqual(derived.requirements.text, ['肌钙蛋白']);
    assert.deepEqual(derived.requirements.pages, { min: 1 });
  });

  await t.test('a legacy visual review carries over as evidence', async () => {
    if (!pdfRuntime.renderer) {
      t.skip('Poppler rendering unavailable; cannot record a visual review here');
      return;
    }
    const review = path.join(dir, 'review.json');
    await writeFile(review, JSON.stringify({
      schema: 'pilotdeck-qa-review/v1',
      artifactSha256: artifactSha,
      pageCount: pages,
      reviewer: 'human',
      pages: Array.from({ length: pages }, (_, index) => ({
        page: index + 1, status: 'passed', notes: `第 ${index + 1} 页版式正常`,
      })),
    }));
    const reviewedPath = path.join(dir, 'delivery-reviewed.json');
    const reviewed = run('bash', [pdfScript, 'deliver', '--input', pdf,
      '--require-text', '肌钙蛋白', '--visual-review', review, '--report', reviewedPath]);
    assert.equal(reviewed.status, 0, reviewed.text);

    const result = adapt('pdf', ['--report', reviewedPath, '--artifact', pdf,
      '--out', path.join(dir, 'qa-report-reviewed.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed');
    const report = JSON.parse(await readFile(path.join(dir, 'qa-report-reviewed.json'), 'utf8'));
    assert.equal(report.checks.visual, 'passed');
    assert.equal(report.visualEvidence.artifactSha256, artifactSha);
    assert.deepEqual(report.visualEvidence.pagesReviewed, [1]);
  });

  await t.test('missing required text fails the delivery', async () => {
    const missingPath = path.join(dir, 'delivery-missing.json');
    const missing = run('bash', [pdfScript, 'deliver', '--input', pdf,
      '--require-text', '不存在的文字', '--report', missingPath]);
    assert.equal(missing.status, 3, missing.text);
    const result = adapt('pdf', ['--report', missingPath, '--artifact', pdf,
      '--out', path.join(dir, 'qa-report-missing.json')]);
    assert.equal(result.status, 1);
    assert.equal(result.json.status, 'failed');
    assert.equal(result.json.checks.content, 'failed');
    assert.equal(result.json.checks.structural, 'passed');
  });

  await t.test('a review bound to a changed file fails the delivery', async () => {
    const changed = path.join(dir, 'changed.pdf');
    await copyFile(pdf, changed);
    await appendFile(changed, 'changed');
    const changedReview = path.join(dir, 'review-changed.json');
    await writeFile(changedReview, JSON.stringify({
      schema: 'pilotdeck-qa-review/v1',
      artifactSha256: artifactSha,
      pageCount: pages,
      pages: [{ page: 1, status: 'passed', notes: 'stale' }],
    }));
    const stalePath = path.join(dir, 'delivery-stale.json');
    const stale = run('bash', [pdfScript, 'deliver', '--input', changed,
      '--visual-review', changedReview, '--report', stalePath]);
    assert.equal(stale.status, 3, stale.text);
    const result = adapt('pdf', ['--report', stalePath, '--artifact', changed,
      '--out', path.join(dir, 'qa-report-stale.json')]);
    assert.equal(result.json.status, 'failed');
    assert.equal(result.json.checks.visual, 'failed');
  });

  await t.test('without Poppler the PDF is still delivered with a warning', async () => {
    const noPoppler = { PDF_SKILL_PDFINFO: '', PDF_SKILL_PDFTOPPM: '' };
    const builtPath = path.join(dir, 'degraded.pdf');
    const built = run('bash', [pdfScript, 'make', '--title', '降级测试',
      '--body', '无 Poppler 环境下仍应能生成并交付 PDF。', '--out', builtPath], noPoppler);
    assert.equal(built.status, 0, built.text);
    assert.equal(built.json.visualAcceptance, 'not_performed');

    const degradedPath = path.join(dir, 'delivery-degraded.json');
    const degraded = run('bash', [pdfScript, 'deliver', '--input', builtPath,
      '--require-text', '降级', '--report', degradedPath], noPoppler);
    assert.equal(degraded.status, 0, degraded.text);
    const degradedReport = JSON.parse(await readFile(degradedPath, 'utf8'));
    assert.equal(degradedReport.render.status, 'skipped');
    assert.equal(degradedReport.status, 'passed_with_warnings');

    const result = adapt('pdf', ['--report', degradedPath, '--artifact', builtPath,
      '--out', path.join(dir, 'qa-report-degraded.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed_with_warnings');
    assert.equal(result.json.checks.structural, 'passed');
    assert.equal(result.json.checks.visual, 'not_performed');

    const blockedPath = path.join(dir, 'delivery-blocked.json');
    const blocked = run('bash', [pdfScript, 'deliver', '--input', builtPath,
      '--require-render', '--report', blockedPath], noPoppler);
    assert.equal(blocked.status, 3, blocked.text);
    const blockedResult = adapt('pdf', ['--report', blockedPath, '--artifact', builtPath,
      '--out', path.join(dir, 'qa-report-blocked.json')]);
    assert.equal(blockedResult.json.status, 'failed');
  });
});

test('XLSX reports adapt into the unified report', {
  skip: xlsxRuntime.ready ? false : `spreadsheet runtime not installed: ${JSON.stringify(xlsxRuntime.detail)}`,
}, async (t) => {
  const dir = await workspace(t, 'xlsx');
  const book = path.join(dir, 'book.xlsx');
  const made = run('bash', [path.join(repo, 'skills/spreadsheets/scripts/spreadsheet.sh'), 'make',
    '--title', '入组患者随访表', '--body', '列A', '--out', book]);
  assert.equal(made.status, 0, made.text);

  const requirements = path.join(dir, 'requirements.json');
  await writeFile(requirements, JSON.stringify({
    requiredSheets: ['Sheet1'],
    requiredNonEmptyRanges: [{ sheet: 'Sheet1', range: 'A1:A3', minCount: 1 }],
  }));
  const deliverable = path.join(dir, 'final.xlsx');
  const reportPath = path.join(dir, 'deliver-report.json');
  const delivered = run('bash', [path.join(repo, 'skills/spreadsheets/scripts/spreadsheet.sh'), 'deliver',
    '--input', book, '--out', deliverable, '--qa-dir', path.join(dir, 'qa'),
    '--requirements', requirements, '--report', reportPath]);
  assert.equal(delivered.status, 0, delivered.text);

  await t.test('a passing delivery becomes passed_with_warnings', async () => {
    const result = adapt('xlsx', ['--report', reportPath, '--artifact', deliverable,
      '--out', path.join(dir, 'qa-report.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed_with_warnings');
    assert.equal(result.json.checks.structural, 'passed');
    assert.equal(result.json.checks.content, 'passed');
    assert.equal(result.json.checks.visual, 'not_performed');
    const derived = JSON.parse(await readFile(path.join(dir, 'acceptance.derived.json'), 'utf8'));
    assert.ok(derived.requirements.text.some((item) => item.includes('required_sheet')));
  });

  await t.test('a failed requirement audit becomes failed', async () => {
    const badRequirements = path.join(dir, 'bad-requirements.json');
    await writeFile(badRequirements, JSON.stringify({ requiredSheets: ['不存在的表'] }));
    const failedReport = path.join(dir, 'audit-failed.json');
    const audited = run('bash', [path.join(repo, 'skills/spreadsheets/scripts/spreadsheet.sh'), 'audit',
      '--input', deliverable, '--requirements', badRequirements, '--out', failedReport]);
    assert.equal(audited.status, 1, audited.text);
    const result = adapt('xlsx', ['--report', failedReport, '--artifact', deliverable,
      '--out', path.join(dir, 'qa-report-failed.json')]);
    assert.equal(result.status, 1);
    assert.equal(result.json.status, 'failed');
    assert.equal(result.json.checks.structural, 'passed');
    assert.equal(result.json.checks.content, 'failed');
  });
});

// T3b.2: HTML and diagrams have no server-side renderer, so their adapters must
// report structural/content facts and never claim a visual pass.
const CLEAN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>病例小结</title></head>
<body><main><h1>病例小结</h1><section><h2>结论</h2><p>患者症状缓解，建议两周后复诊。</p></section></main></body></html>
`;

const IMAGE_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>影像小结</title></head>
<body><main><h1>影像小结</h1><section><h2>结论</h2><p>影像未见异常。</p>
<img src="assets/missing.png" alt="胸部影像"></section></main></body></html>
`;

const LONG_LABEL = '这是一个非常长的节点说明文字用来触发三行上限的截断问题需要超过三十三个汉字才可以';

test('HTML audit and package adapt into the unified report', async (t) => {
  const ws = await workspace(t, 'html');
  await mkdir(path.join(ws, 'exports'), { recursive: true });

  await t.test('required text and headings become a content check', async () => {
    const page = path.join(ws, 'exports/报告.html');
    await writeFile(page, CLEAN_PAGE);
    const auditPath = path.join(ws, 'audit.json');
    const audited = run('bash', [htmlScript, 'audit', page, '--require-text', '建议两周后复诊',
      '--require-heading', '病例小结', '--out', auditPath]);
    assert.equal(audited.status, 0, audited.text);
    const report = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(report.visual_acceptance, 'not_performed');

    const result = adapt('html', ['--report', auditPath, '--artifact', page,
      '--out', path.join(ws, 'qa-report.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed_with_warnings');
    assert.equal(result.json.checks.structural, 'passed');
    assert.equal(result.json.checks.content, 'passed');
    assert.equal(result.json.checks.visual, 'not_performed');
    const derived = JSON.parse(await readFile(path.join(ws, 'acceptance.derived.json'), 'utf8'));
    assert.deepEqual(derived.requirements.text, ['建议两周后复诊']);
    assert.equal(derived.skill, 'html');
  });

  await t.test('a missing required sentence fails the content check only', async () => {
    const page = path.join(ws, 'exports/报告.html');
    const auditPath = path.join(ws, 'audit-missing-text.json');
    const audited = run('bash', [htmlScript, 'audit', page, '--require-text', '不存在的结论',
      '--out', auditPath]);
    assert.equal(audited.status, 1, audited.text);
    const out = path.join(ws, 'qa-report-missing-text.json');
    const result = adapt('html', ['--report', auditPath, '--artifact', page, '--out', out]);
    assert.equal(result.status, 1);
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.checks.structural, 'passed');
    assert.equal(report.checks.content, 'failed');
    assert.ok(report.issues.some((item) => item.code === 'requirement-not-met:text'));
  });

  await t.test('a missing image stays a delivery gap for both gates', async () => {
    const page = path.join(ws, 'exports/影像.html');
    await writeFile(page, IMAGE_PAGE);
    const auditPath = path.join(ws, 'audit-image.json');
    const audited = run('bash', [htmlScript, 'audit', page, '--out', auditPath]);
    assert.equal(audited.status, 1, audited.text);

    const auditOut = path.join(ws, 'qa-report-image.json');
    const fromAudit = adapt('html', ['--report', auditPath, '--artifact', page,
      '--out', auditOut]);
    assert.equal(fromAudit.status, 0, fromAudit.text);
    const auditReport = JSON.parse(await readFile(auditOut, 'utf8'));
    assert.equal(auditReport.status, 'delivered_with_missing_assets');
    assert.equal(auditReport.checks.structural, 'passed');
    assert.equal(auditReport.checks.assets, 'missing');
    assert.equal(auditReport.checks.visual, 'not_performed');
    assert.equal(auditReport.missingAssets.length, 1);

    const packagePath = path.join(ws, 'package.json');
    const packaged = run('bash', [htmlScript, 'package', '--html', page, '--workspace', ws,
      '--timezone', 'Asia/Shanghai', '--report', packagePath]);
    assert.equal(packaged.status, 0, packaged.text);
    const packageReport = JSON.parse(await readFile(packagePath, 'utf8'));
    assert.equal(packageReport.status, 'delivered_with_missing_assets');

    const packageOut = path.join(ws, 'qa-report-package.json');
    const fromPackage = adapt('html', ['--report', packagePath, '--artifact', packageReport.index,
      '--out', packageOut]);
    assert.equal(fromPackage.status, 0, fromPackage.text);
    const packagedReport = JSON.parse(await readFile(packageOut, 'utf8'));
    assert.equal(packagedReport.status, 'delivered_with_missing_assets');
    assert.equal(packagedReport.checks.structural, 'passed');
    assert.equal(packagedReport.checks.content, 'not_checked');
    assert.equal(packagedReport.checks.visual, 'not_performed');
    assert.equal(packagedReport.missingAssets.length, 1);
    assert.equal(packagedReport.missingAssets[0].replaced, true);
    assert.equal(packagedReport.legacy.kind, 'package');
  });
});

test('Diagram geometry audit adapts into the unified report', async (t) => {
  const ws = await workspace(t, 'diagram');

  await t.test('a clean flow passes with visual still not performed', async () => {
    const svg = path.join(ws, 'flow.svg');
    const made = run('bash', [diagramScript, 'make', '--body', '入院 → 评估 → 治疗 → 出院',
      '--title', '流程', '--out', svg]);
    assert.equal(made.status, 0, made.text);
    assert.deepEqual(made.json.warnings, []);

    const auditPath = path.join(ws, 'diagram-audit.json');
    const audited = run('bash', [diagramScript, 'audit', '--input', svg, '--report', auditPath]);
    assert.equal(audited.status, 0, audited.text);
    const report = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(report.status, 'ok');
    assert.equal(report.counts.nodes, 4);
    assert.equal(report.visual_acceptance, 'not_performed');

    const result = adapt('diagram', ['--report', auditPath, '--artifact', svg,
      '--out', path.join(ws, 'qa-report.json')]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json.status, 'passed_with_warnings');
    assert.equal(result.json.checks.structural, 'passed');
    assert.equal(result.json.checks.content, 'not_checked');
    assert.equal(result.json.checks.visual, 'not_performed');
  });

  await t.test('a label that overflows three lines is a content failure', async () => {
    const svg = path.join(ws, 'long.svg');
    const made = run('bash', [diagramScript, 'make', '--body', `${LONG_LABEL} → 复诊`, '--out', svg]);
    assert.equal(made.status, 0, made.text);
    assert.equal(made.json.warnings[0].code, 'label-truncated');

    const auditPath = path.join(ws, 'long-audit.json');
    const audited = run('bash', [diagramScript, 'audit', '--body', `${LONG_LABEL} → 复诊`,
      '--report', auditPath]);
    assert.equal(audited.status, 1);
    const result = adapt('diagram', ['--report', auditPath, '--artifact', svg,
      '--out', path.join(ws, 'qa-report-long.json')]);
    assert.equal(result.status, 1);
    assert.equal(result.json.status, 'failed');
    assert.equal(result.json.checks.structural, 'passed');
    assert.equal(result.json.checks.content, 'failed');
    assert.equal(result.json.checks.visual, 'not_performed');
  });

  await t.test('a diagram wider than the report column is a warning, not a failure', async () => {
    const svg = path.join(ws, 'wide.svg');
    // A plain six-step chain would now auto-rotate to TB (it exceeds the
    // 1200px report budget), so pin the horizontal layout this case is about.
    const made = run('bash', [diagramScript, 'make', '--body', '一 → 二 → 三 → 四 → 五 → 六',
      '--direction', 'LR', '--out', svg]);
    assert.equal(made.status, 0, made.text);
    const auditPath = path.join(ws, 'wide-audit.json');
    const audited = run('bash', [diagramScript, 'audit', '--input', svg, '--report', auditPath]);
    assert.equal(audited.status, 0, audited.text);
    const report = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(report.budget.exceeded, true);
    assert.ok(report.issues.some((item) => item.code === 'too-wide-for-report-width'));

    const result = adapt('diagram', ['--report', auditPath, '--artifact', svg,
      '--out', path.join(ws, 'qa-report-wide.json')]);
    assert.equal(result.json.status, 'passed_with_warnings');
    assert.equal(result.json.checks.structural, 'passed');
  });

  await t.test('a node drawn outside the viewBox is a structural failure', async () => {
    const svg = path.join(ws, 'outside.svg');
    await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" '
      + 'viewBox="0 0 400 200"><rect width="100%" height="100%" fill="#fff"/>'
      + '<rect x="300" y="40" width="184" height="72" rx="12" fill="#e2e8f0"/>'
      + '<text x="392" y="80" font-size="14">溢出</text></svg>');
    const auditPath = path.join(ws, 'outside-audit.json');
    const audited = run('bash', [diagramScript, 'audit', '--input', svg, '--report', auditPath]);
    assert.equal(audited.status, 1, audited.text);
    const report = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.ok(report.issues.some((item) => item.code === 'node-outside-viewbox'));

    const result = adapt('diagram', ['--report', auditPath, '--artifact', svg,
      '--out', path.join(ws, 'qa-report-outside.json')]);
    assert.equal(result.json.status, 'failed');
    assert.equal(result.json.checks.structural, 'failed');
  });

  await t.test('an artifact rendered before the last edit is caught', async () => {
    const svg = path.join(ws, 'stale.svg');
    const made = run('bash', [diagramScript, 'make', '--body', '入院 → 评估', '--out', svg]);
    assert.equal(made.status, 0, made.text);
    const auditPath = path.join(ws, 'stale-audit.json');
    const audited = run('bash', [diagramScript, 'audit', '--input', svg,
      '--body', '入院 → 评估 → 治疗 → 出院', '--report', auditPath]);
    assert.equal(audited.status, 1, audited.text);
    const report = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.ok(report.issues.some((item) => item.code === 'label-not-rendered'));

    const result = adapt('diagram', ['--report', auditPath, '--artifact', svg,
      '--out', path.join(ws, 'qa-report-stale.json')]);
    assert.equal(result.json.status, 'failed');
    assert.equal(result.json.checks.structural, 'failed');
  });
});
