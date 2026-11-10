// T3b.3: four regression classes for the unified QA layer —
//   正例 positive : the delivered artifact and the report agree
//   反例 negative : an unmet requirement is reported as such, and a changed
//                   artifact invalidates the old evidence
//   降级 degraded : no renderer still yields a deliverable plus honest states
//   旧流程 legacy  : old commands still work, old report shapes still read, and
//                   the adapter never rewrites the legacy report
//
// Real producers are used. Formats whose pinned runtime is missing are skipped
// with an explicit message instead of pretending to pass.

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
const docxScript = path.join(repo, 'skills/docx/scripts/docx.sh');
const pptxScript = path.join(repo, 'skills/pptx/scripts/pptx.sh');
const pdfScript = path.join(repo, 'skills/pdf/scripts/pdf.sh');
const xlsxScript = path.join(repo, 'skills/spreadsheets/scripts/spreadsheet.sh');
const htmlScript = path.join(repo, 'skills/frontend-slides/scripts/html.sh');
const diagramScript = path.join(repo, 'skills/diagram-maker/scripts/diagram.sh');
const python = process.env.PILOTDECK_TEST_PYTHON ?? 'python3';
const DEAD_RENDERER = 'http://127.0.0.1:9';

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

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function workspace(t, name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `qa-regression-${name}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runtime(script) {
  const result = run('bash', [script, 'check']);
  return {
    ready: result.json?.status === 'ok' || result.json?.usable === true,
    detail: result.json ?? result.text,
  };
}

const RUNTIMES = {
  docx: runtime(docxScript),
  pptx: runtime(pptxScript),
  pdf: runtime(pdfScript),
  xlsx: runtime(xlsxScript),
};

function skipUnless(skill) {
  const state = RUNTIMES[skill];
  return state.ready ? false : `${skill} runtime not installed: ${JSON.stringify(state.detail)}`;
}

async function adapt(skill, { argv, out }) {
  const result = run(python, [adaptScript, skill, ...argv, '--out', out,
    '--now', '2026-11-09T00:00:00+00:00']);
  let report = null;
  try {
    report = JSON.parse(await readFile(out, 'utf8'));
  } catch {
    report = null;
  }
  return { status: result.status, json: result.json, report, text: result.text };
}

function allowed(status) {
  return ['passed', 'passed_with_warnings', 'delivered_with_missing_assets'].includes(status);
}

async function assertBoundToArtifact(report, artifactPath, reportPath) {
  const digest = sha256(await readFile(artifactPath));
  assert.equal(report.artifact.sha256, digest, 'the report must bind the current artifact hash');
  assert.equal(report.checks.visual, 'not_performed', 'no review means no visual claim');
  assert.equal(run(python, [protocolScript, 'validate-report', reportPath]).status, 0);
}

function stripKeys(report, keys) {
  const copy = JSON.parse(JSON.stringify(report));
  for (const key of keys) delete copy[key];
  return copy;
}

test('DOCX: positive, negative, degraded and legacy flows stay consistent', {
  skip: skipUnless('docx'),
}, async (t) => {
  const dir = await workspace(t, 'docx');
  const docx = path.join(dir, 'report.docx');
  const made = run('bash', [docxScript, 'make', '--title', '急性心肌梗死病例报告',
    '--body', '患者男性，58岁，因胸痛3小时入院。心电图示ST段抬高，肌钙蛋白升高。',
    '--out', docx]);
  assert.equal(made.status, 0, made.text);

  const acceptance = path.join(dir, 'acceptance.json');
  await writeFile(acceptance, JSON.stringify({
    required_text: ['肌钙蛋白'], page_count: { min: 1, max: 3 }, images: { min: 0 },
  }));
  const goodReport = path.join(dir, 'preflight.json');
  const preflight = run('bash', [docxScript, 'preflight', '--input', docx,
    '--out-dir', path.join(dir, 'render'), '--report', goodReport, '--acceptance', acceptance]);
  if (!preflight.json) {
    t.skip('DOCX preflight produced no report here; positive/negative split not observable');
    return;
  }

  await t.test('positive: a satisfied requirement maps to passed_with_warnings', async () => {
    const out = path.join(dir, 'qa-report.json');
    const result = await adapt('docx', { argv: ['--report', goodReport, '--artifact', docx], out });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.status, 'passed_with_warnings');
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.content, 'passed');
    await assertBoundToArtifact(result.report, docx, out);
  });

  await t.test('negative: missing required text fails content, not structure', async () => {
    const badAcceptance = path.join(dir, 'acceptance-missing.json');
    await writeFile(badAcceptance, JSON.stringify({
      required_text: ['不存在的结论'], page_count: { min: 1, max: 3 }, images: { min: 0 },
    }));
    const badReport = path.join(dir, 'preflight-missing.json');
    const bad = run('bash', [docxScript, 'preflight', '--input', docx,
      '--out-dir', path.join(dir, 'render-missing'), '--report', badReport,
      '--acceptance', badAcceptance]);
    assert.ok(bad.json, bad.text);
    const result = await adapt('docx', {
      argv: ['--report', badReport, '--artifact', docx],
      out: path.join(dir, 'qa-report-missing.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.content, 'failed');
  });

  await t.test('negative: a changed artifact invalidates the preflight', async () => {
    const changed = path.join(dir, 'changed.docx');
    await copyFile(docx, changed);
    await appendFile(changed, 'x');
    const result = await adapt('docx', {
      argv: ['--report', goodReport, '--artifact', changed],
      out: path.join(dir, 'qa-report-changed.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.checks.structural, 'failed');
    assert.ok(result.report.issues
      .some((item) => item.code === 'artifact-changed-since-preflight'));
  });

  await t.test('degraded: no renderer still yields a report and honest states', async () => {
    const degradedReport = path.join(dir, 'preflight-degraded.json');
    const degraded = run('bash', [docxScript, 'preflight', '--input', docx,
      '--out-dir', path.join(dir, 'render-degraded'), '--report', degradedReport,
      '--acceptance', acceptance], { PILOTDECK_OFFICE_RENDERER_URL: DEAD_RENDERER });
    assert.ok(degraded.json, degraded.text);
    const legacy = JSON.parse(await readFile(degradedReport, 'utf8'));
    assert.equal(legacy.status, 'partial');
    assert.equal(legacy.checks.render, 'skipped');
    assert.equal(legacy.checks.text_coverage, 'not_checked');
    assert.equal(legacy.coverage.status, 'not_checked');
    assert.ok(legacy.gate_issues.some((item) => item.code === 'render-unavailable'));

    const out = path.join(dir, 'qa-report-degraded.json');
    const result = await adapt('docx', { argv: ['--report', degradedReport, '--artifact', docx], out });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.status, 'passed_with_warnings');
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.content, 'not_checked');
    assert.equal(result.report.checks.visual, 'not_performed');
    assert.ok(result.report.issues.some((item) => item.code === 'render-unavailable'));
  });

  await t.test('legacy: an older report shape still maps, and is never rewritten', async () => {
    const legacy = JSON.parse(await readFile(goodReport, 'utf8'));
    const older = stripKeys(legacy, ['visual_review']);
    if (older.render && typeof older.render === 'object') delete older.render.page_evidence;
    const olderPath = path.join(dir, 'preflight-legacy.json');
    await writeFile(olderPath, JSON.stringify(older));
    const before = sha256(await readFile(olderPath));
    const result = await adapt('docx', {
      argv: ['--report', olderPath, '--artifact', docx],
      out: path.join(dir, 'qa-report-legacy.json'),
    });
    assert.ok(allowed(result.report.status), result.text);
    assert.equal(sha256(await readFile(olderPath)), before, 'the adapter must not touch its input');
    assert.equal(made.json.status, 'ok');
    assert.ok(made.json.audit && made.json.validation, 'make keeps its documented keys');
  });
});

test('PPTX: positive, negative, degraded and legacy flows stay consistent', {
  skip: skipUnless('pptx'),
}, async (t) => {
  const dir = await workspace(t, 'pptx');
  const deck = path.join(dir, 'deck.pptx');
  const made = run('bash', [pptxScript, 'make', '--title', '病例讨论',
    '--body', '# 病史\n患者男性，58岁，胸痛3小时。\n\n# 检查\n肌钙蛋白升高。', '--out', deck]);
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
  const delivered = run('bash', [pptxScript, 'deliver', '--input', deck, '--out', deliverable,
    '--qa-dir', qaDir, '--requirements', requirements, '--require-coverage']);
  assert.equal(delivered.status, 0, delivered.text);
  const deliveryPath = path.join(qaDir, 'delivery.json');

  await t.test('positive: renders are recorded, visual stays not performed', async () => {
    const out = path.join(dir, 'qa-report.json');
    const result = await adapt('pptx', { argv: ['--report', deliveryPath, '--artifact', deliverable], out });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.status, 'passed_with_warnings');
    assert.equal(result.report.checks.content, 'passed');
    await assertBoundToArtifact(result.report, deliverable, out);
  });

  await t.test('negative: an unmet delivery requirement fails the report', async () => {
    const badRequirements = path.join(dir, 'requirements-bad.json');
    await writeFile(badRequirements, JSON.stringify({
      slideCount: 2,
      requirements: [{ id: 'lab', label: '实验室检查', terms: ['不存在的指标'] }],
    }));
    const badQa = path.join(dir, 'qa-bad');
    const bad = run('bash', [pptxScript, 'deliver', '--input', deck,
      '--out', path.join(dir, 'bad.pptx'), '--qa-dir', badQa,
      '--requirements', badRequirements, '--require-coverage']);
    assert.notEqual(bad.status, 0, bad.text);
    const result = await adapt('pptx', {
      // A refused delivery never seals an output, so the report still points at
      // the inspected deck.
      argv: ['--report', path.join(badQa, 'delivery.json'), '--artifact', deck],
      out: path.join(dir, 'qa-report-bad.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.status, 'failed');
  });

  await t.test('negative: a changed artifact invalidates the delivery record', async () => {
    const changed = path.join(dir, 'changed.pptx');
    await copyFile(deliverable, changed);
    await appendFile(changed, 'x');
    const result = await adapt('pptx', {
      argv: ['--report', deliveryPath, '--artifact', changed],
      out: path.join(dir, 'qa-report-changed.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.checks.structural, 'failed');
    assert.ok(result.report.issues
      .some((item) => item.code === 'artifact-changed-since-delivery'));
  });

  await t.test('degraded: no renderer still delivers with not_performed', async () => {
    const degradedQa = path.join(dir, 'qa-degraded');
    const degradedOut = path.join(dir, 'degraded.pptx');
    const degraded = run('bash', [pptxScript, 'deliver', '--input', deck, '--out', degradedOut,
      '--qa-dir', degradedQa, '--requirements', requirements, '--require-coverage'],
    { PILOTDECK_OFFICE_RENDERER_URL: DEAD_RENDERER });
    assert.equal(degraded.status, 0, degraded.text);
    const legacy = JSON.parse(await readFile(path.join(degradedQa, 'delivery.json'), 'utf8'));
    assert.equal(legacy.render.status, 'skipped');
    const result = await adapt('pptx', {
      argv: ['--report', path.join(degradedQa, 'delivery.json'), '--artifact', degradedOut],
      out: path.join(dir, 'qa-report-degraded.json'),
    });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.status, 'passed_with_warnings');
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.visual, 'not_performed');
  });

  await t.test('legacy: a delivery report without render evidence still maps', async () => {
    const legacy = JSON.parse(await readFile(deliveryPath, 'utf8'));
    const olderPath = path.join(dir, 'delivery-legacy.json');
    await writeFile(olderPath, JSON.stringify(stripKeys(legacy, ['render'])));
    const before = sha256(await readFile(olderPath));
    const result = await adapt('pptx', {
      argv: ['--report', olderPath, '--artifact', deliverable],
      out: path.join(dir, 'qa-report-legacy.json'),
    });
    assert.ok(allowed(result.report.status), result.text);
    assert.equal(result.report.checks.visual, 'not_performed');
    assert.equal(sha256(await readFile(olderPath)), before, 'the adapter must not touch its input');
  });
});

test('XLSX: positive, negative, degraded and legacy flows stay consistent', {
  skip: skipUnless('xlsx'),
}, async (t) => {
  const dir = await workspace(t, 'xlsx');
  const book = path.join(dir, 'book.xlsx');
  const made = run('bash', [xlsxScript, 'make', '--title', '入组患者随访表', '--body', '列A',
    '--out', book]);
  assert.equal(made.status, 0, made.text);

  const requirements = path.join(dir, 'requirements.json');
  await writeFile(requirements, JSON.stringify({
    requiredSheets: ['Sheet1'],
    requiredNonEmptyRanges: [{ sheet: 'Sheet1', range: 'A1:A3', minCount: 1 }],
  }));
  const deliverable = path.join(dir, 'final.xlsx');
  const reportPath = path.join(dir, 'deliver-report.json');
  const delivered = run('bash', [xlsxScript, 'deliver', '--input', book, '--out', deliverable,
    '--qa-dir', path.join(dir, 'qa'), '--requirements', requirements, '--report', reportPath]);
  assert.equal(delivered.status, 0, delivered.text);

  await t.test('positive: a satisfied requirement maps to passed_with_warnings', async () => {
    const out = path.join(dir, 'qa-report.json');
    const result = await adapt('xlsx', { argv: ['--report', reportPath, '--artifact', deliverable], out });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.status, 'passed_with_warnings');
    assert.equal(result.report.checks.content, 'passed');
    await assertBoundToArtifact(result.report, deliverable, out);
  });

  await t.test('negative: a missing sheet fails content, not structure', async () => {
    const badRequirements = path.join(dir, 'bad-requirements.json');
    await writeFile(badRequirements, JSON.stringify({ requiredSheets: ['不存在的表'] }));
    const failedReport = path.join(dir, 'audit-failed.json');
    const audited = run('bash', [xlsxScript, 'audit', '--input', deliverable,
      '--requirements', badRequirements, '--out', failedReport]);
    assert.equal(audited.status, 1, audited.text);
    const result = await adapt('xlsx', {
      argv: ['--report', failedReport, '--artifact', deliverable],
      out: path.join(dir, 'qa-report-failed.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.content, 'failed');
  });

  await t.test('negative: a changed artifact invalidates the delivery record', async () => {
    const changed = path.join(dir, 'changed.xlsx');
    await copyFile(deliverable, changed);
    await appendFile(changed, 'x');
    const result = await adapt('xlsx', {
      argv: ['--report', reportPath, '--artifact', changed],
      out: path.join(dir, 'qa-report-changed.json'),
    });
    assert.equal(result.status, 1);
    assert.ok(result.report.issues
      .some((item) => item.code.startsWith('artifact-changed-since')));
  });

  await t.test('degraded: no renderer still delivers', async () => {
    const out = path.join(dir, 'qa-report-degraded.json');
    const degradedReport = path.join(dir, 'degraded-report.json');
    const degraded = run('bash', [xlsxScript, 'deliver', '--input', book,
      '--out', path.join(dir, 'degraded.xlsx'), '--qa-dir', path.join(dir, 'qa-degraded'),
      '--requirements', requirements, '--report', degradedReport],
    { PILOTDECK_OFFICE_RENDERER_URL: DEAD_RENDERER });
    assert.equal(degraded.status, 0, degraded.text);
    const result = await adapt('xlsx', {
      argv: ['--report', degradedReport, '--artifact', path.join(dir, 'degraded.xlsx')], out,
    });
    assert.equal(result.status, 0, result.text);
    assert.ok(allowed(result.report.status), result.report.status);
    assert.equal(result.report.checks.visual, 'not_performed');
  });

  await t.test('legacy: a report without render fields still maps', async () => {
    const legacy = JSON.parse(await readFile(reportPath, 'utf8'));
    const olderPath = path.join(dir, 'deliver-legacy.json');
    await writeFile(olderPath, JSON.stringify(stripKeys(legacy, ['render', 'preview'])));
    const before = sha256(await readFile(olderPath));
    const result = await adapt('xlsx', {
      argv: ['--report', olderPath, '--artifact', deliverable],
      out: path.join(dir, 'qa-report-legacy.json'),
    });
    assert.ok(allowed(result.report.status), result.text);
    assert.equal(sha256(await readFile(olderPath)), before, 'the adapter must not touch its input');
  });
});

test('PDF: positive, negative, degraded and legacy flows stay consistent', {
  skip: skipUnless('pdf'),
}, async (t) => {
  const dir = await workspace(t, 'pdf');
  const pdf = path.join(dir, 'report.pdf');
  const made = run('bash', [pdfScript, 'make', '--title', '急性心肌梗死病例报告',
    '--body', '患者男性，58岁，胸痛3小时入院。肌钙蛋白升高，行急诊PCI治疗。', '--out', pdf]);
  assert.equal(made.status, 0, made.text);

  const reportPath = path.join(dir, 'delivery.json');
  const delivered = run('bash', [pdfScript, 'deliver', '--input', pdf,
    '--require-text', '肌钙蛋白', '--min-pages', '1', '--report', reportPath]);
  assert.equal(delivered.status, 0, delivered.text);

  await t.test('positive: requirements come from the delivery coverage', async () => {
    const out = path.join(dir, 'qa-report.json');
    const result = await adapt('pdf', { argv: ['--report', reportPath, '--artifact', pdf], out });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.status, 'passed_with_warnings');
    assert.equal(result.report.checks.content, 'passed');
    await assertBoundToArtifact(result.report, pdf, out);
    const derived = JSON.parse(await readFile(path.join(dir, 'acceptance.derived.json'), 'utf8'));
    assert.deepEqual(derived.requirements.text, ['肌钙蛋白']);
  });

  await t.test('negative: missing required text fails content, not structure', async () => {
    const badReport = path.join(dir, 'delivery-missing.json');
    const bad = run('bash', [pdfScript, 'deliver', '--input', pdf,
      '--require-text', '不存在的结论', '--report', badReport]);
    assert.notEqual(bad.status, 0, bad.text);
    const result = await adapt('pdf', {
      argv: ['--report', badReport, '--artifact', pdf],
      out: path.join(dir, 'qa-report-missing.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.content, 'failed');
  });

  await t.test('negative: a changed artifact invalidates the delivery', async () => {
    const changed = path.join(dir, 'changed.pdf');
    await copyFile(pdf, changed);
    await appendFile(changed, 'x');
    const result = await adapt('pdf', {
      argv: ['--report', reportPath, '--artifact', changed],
      out: path.join(dir, 'qa-report-changed.json'),
    });
    assert.equal(result.status, 1);
    assert.ok(result.report.issues
      .some((item) => item.code === 'artifact-changed-since-delivery'));
  });

  await t.test('degraded: without Poppler the PDF is still delivered', async () => {
    const noPoppler = { PDF_SKILL_PDFINFO: '', PDF_SKILL_PDFTOPPM: '' };
    const degradedReport = path.join(dir, 'delivery-degraded.json');
    const degraded = run('bash', [pdfScript, 'deliver', '--input', pdf,
      '--require-text', '肌钙蛋白', '--report', degradedReport], noPoppler);
    assert.equal(degraded.status, 0, degraded.text);
    const legacy = JSON.parse(await readFile(degradedReport, 'utf8'));
    assert.equal(legacy.render.status, 'skipped');
    const result = await adapt('pdf', {
      argv: ['--report', degradedReport, '--artifact', pdf],
      out: path.join(dir, 'qa-report-degraded.json'),
    });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.status, 'passed_with_warnings');
    assert.equal(result.report.checks.visual, 'not_performed');
  });

  await t.test('legacy: a delivery report without visual review still maps', async () => {
    const legacy = JSON.parse(await readFile(reportPath, 'utf8'));
    const olderPath = path.join(dir, 'delivery-legacy.json');
    await writeFile(olderPath, JSON.stringify(stripKeys(legacy, ['visualReview'])));
    const before = sha256(await readFile(olderPath));
    const result = await adapt('pdf', {
      argv: ['--report', olderPath, '--artifact', pdf],
      out: path.join(dir, 'qa-report-legacy.json'),
    });
    assert.ok(allowed(result.report.status), result.text);
    assert.equal(result.report.checks.visual, 'not_performed');
    assert.equal(sha256(await readFile(olderPath)), before, 'the adapter must not touch its input');
  });
});

// HTML and diagrams have no server-side renderer at all: their "degraded" state
// is the normal state, so the assertions below pin visual=not_performed and the
// absence of any browser dependency instead of simulating an outage.
const PAGE_WITH_IMAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>影像小结</title></head>
<body><main><h1>影像小结</h1><section><h2>结论</h2>
<p>患者症状缓解，建议两周后复诊。</p><img src="assets/photo.png" alt="胸部影像">
</section></main></body></html>
`;

test('HTML: positive, negative and legacy flows stay consistent', async (t) => {
  const ws = await workspace(t, 'html');
  await mkdir(path.join(ws, 'exports/assets'), { recursive: true });
  const page = path.join(ws, 'exports/影像小结.html');
  await writeFile(page, PAGE_WITH_IMAGE);
  await writeFile(path.join(ws, 'exports/assets/photo.png'),
    Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
      + '0000000a49444154789c6300010000050001d0d3b0b60000000049454e44ae426082', 'hex'));

  const auditPath = path.join(ws, 'audit.json');
  const audited = run('bash', [htmlScript, 'audit', page,
    '--require-text', '建议两周后复诊', '--require-heading', '影像小结', '--out', auditPath]);
  assert.equal(audited.status, 0, audited.text);

  await t.test('positive: requirements verified, folder delivery packaged', async () => {
    const out = path.join(ws, 'qa-report.json');
    const result = await adapt('html', { argv: ['--report', auditPath, '--artifact', page], out });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.status, 'passed_with_warnings');
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.content, 'passed');
    await assertBoundToArtifact(result.report, page, out);

    const packagePath = path.join(ws, 'package.json');
    const packaged = run('bash', [htmlScript, 'package', '--html', page, '--workspace', ws,
      '--timezone', 'Asia/Shanghai', '--report', packagePath]);
    assert.equal(packaged.status, 0, packaged.text);
    const packageReport = JSON.parse(await readFile(packagePath, 'utf8'));
    assert.equal(packageReport.status, 'ok');
    const packagedQa = path.join(ws, 'qa-report-package.json');
    const fromPackage = await adapt('html', {
      argv: ['--report', packagePath, '--artifact', packageReport.index],
      out: packagedQa,
    });
    assert.equal(fromPackage.status, 0, fromPackage.text);
    assert.equal(fromPackage.report.status, 'passed_with_warnings');
    assert.equal(fromPackage.report.checks.visual, 'not_performed');
    assert.equal(fromPackage.report.legacy.kind, 'package');
  });

  await t.test('negative: a missing required sentence fails content only', async () => {
    const badPath = path.join(ws, 'audit-missing.json');
    const bad = run('bash', [htmlScript, 'audit', page, '--require-text', '不存在的结论',
      '--out', badPath]);
    assert.equal(bad.status, 1, bad.text);
    const result = await adapt('html', {
      argv: ['--report', badPath, '--artifact', page],
      out: path.join(ws, 'qa-report-missing.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.content, 'failed');
  });

  await t.test('negative: editing the page after the audit invalidates it', async () => {
    const copy = path.join(ws, 'exports/copy.html');
    await copyFile(page, copy);
    const copyAudit = path.join(ws, 'audit-copy.json');
    run('bash', [htmlScript, 'audit', copy, '--out', copyAudit]);
    await appendFile(copy, '\n<!-- edited -->\n');
    const result = await adapt('html', {
      argv: ['--report', copyAudit, '--artifact', copy],
      out: path.join(ws, 'qa-report-changed.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.checks.structural, 'failed');
    assert.ok(result.report.issues.some((item) => item.code === 'artifact-changed-since-audit'));
  });

  await t.test('legacy: an audit report without requirement data still maps', async () => {
    const legacy = JSON.parse(await readFile(auditPath, 'utf8'));
    if (legacy.document) delete legacy.document.headingTexts;
    const olderPath = path.join(ws, 'audit-legacy.json');
    await writeFile(olderPath, JSON.stringify(stripKeys(legacy, ['requirements', 'sha256'])));
    const before = sha256(await readFile(olderPath));
    const result = await adapt('html', {
      argv: ['--report', olderPath, '--artifact', page],
      out: path.join(ws, 'qa-report-legacy.json'),
    });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.checks.content, 'not_checked');
    assert.equal(result.report.checks.visual, 'not_performed');
    assert.equal(sha256(await readFile(olderPath)), before, 'the adapter must not touch its input');
  });
});

const LONG_LABEL = '这是一个非常长的节点说明文字用来触发三行上限的截断问题需要超过三十三个汉字才可以';

test('Diagram: positive, negative and legacy flows stay consistent', async (t) => {
  const ws = await workspace(t, 'diagram');
  const svg = path.join(ws, 'flow.svg');
  const made = run('bash', [diagramScript, 'make', '--title', '救治流程',
    '--body', '分诊 → 抢救 → 后送', '--out', svg]);
  assert.equal(made.status, 0, made.text);
  assert.deepEqual(made.json.warnings, []);

  const auditPath = path.join(ws, 'audit.json');
  const audited = run('bash', [diagramScript, 'audit', '--input', svg, '--report', auditPath]);
  assert.equal(audited.status, 0, audited.text);

  await t.test('positive: geometry is checked, visual stays not performed', async () => {
    const out = path.join(ws, 'qa-report.json');
    const result = await adapt('diagram', { argv: ['--report', auditPath, '--artifact', svg], out });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.status, 'passed_with_warnings');
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.content, 'not_checked');
    await assertBoundToArtifact(result.report, svg, out);
  });

  await t.test('negative: a truncated label fails content, not structure', async () => {
    const badSvg = path.join(ws, 'long.svg');
    const madeLong = run('bash', [diagramScript, 'make', '--body', `${LONG_LABEL} → 复诊`,
      '--out', badSvg]);
    assert.equal(madeLong.status, 0, madeLong.text);
    assert.equal(madeLong.json.warnings[0].code, 'label-truncated');
    const badAudit = path.join(ws, 'audit-long.json');
    const bad = run('bash', [diagramScript, 'audit', '--input', badSvg,
      '--body', `${LONG_LABEL} → 复诊`, '--report', badAudit]);
    assert.equal(bad.status, 1, bad.text);
    const result = await adapt('diagram', {
      argv: ['--report', badAudit, '--artifact', badSvg],
      out: path.join(ws, 'qa-report-long.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.checks.structural, 'passed');
    assert.equal(result.report.checks.content, 'failed');
  });

  await t.test('negative: editing the SVG after the audit invalidates it', async () => {
    const copy = path.join(ws, 'copy.svg');
    await copyFile(svg, copy);
    const copyAudit = path.join(ws, 'audit-copy.json');
    run('bash', [diagramScript, 'audit', '--input', copy, '--report', copyAudit]);
    await appendFile(copy, '\n<!-- edited -->\n');
    const result = await adapt('diagram', {
      argv: ['--report', copyAudit, '--artifact', copy],
      out: path.join(ws, 'qa-report-changed.json'),
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.checks.structural, 'failed');
    assert.ok(result.report.issues.some((item) => item.code === 'artifact-changed-since-audit'));
  });

  await t.test('legacy: an audit report without geometry content still maps', async () => {
    const legacy = JSON.parse(await readFile(auditPath, 'utf8'));
    const olderPath = path.join(ws, 'audit-legacy.json');
    await writeFile(olderPath, JSON.stringify(stripKeys(legacy, ['content', 'budget', 'sha256'])));
    const before = sha256(await readFile(olderPath));
    const result = await adapt('diagram', {
      argv: ['--report', olderPath, '--artifact', svg],
      out: path.join(ws, 'qa-report-legacy.json'),
    });
    assert.equal(result.status, 0, result.text);
    assert.equal(result.report.checks.content, 'not_checked');
    assert.equal(sha256(await readFile(olderPath)), before, 'the adapter must not touch its input');
  });
});
