import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repo, 'skills/_shared/qa/qa_protocol.py');
const samples = path.join(repo, 'skills/_shared/qa/samples');
const python = process.env.PILOTDECK_TEST_PYTHON ?? 'python3';

function cli(...args) {
  const result = spawnSync(python, [script, ...args], { encoding: 'utf8' });
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    data = null;
  }
  return { status: result.status, data, text: `${result.stdout}${result.stderr}` };
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-protocol-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifact = path.join(dir, 'report.docx');
  const bytes = 'fake-docx-bytes';
  await writeFile(artifact, bytes);
  const acceptance = path.join(dir, 'acceptance.json');
  await writeFile(acceptance, JSON.stringify({
    schema: 'pilotdeck-qa-acceptance/v1',
    skill: 'docx',
    requirements: { text: ['肌钙蛋白'], pages: { min: 1, max: 2 } },
  }));
  return { dir, artifact, acceptance, sha256: sha(bytes) };
}

async function writeReview(dir, { pageCount = 2, statuses = ['passed', 'passed'], artifactSha }) {
  const file = path.join(dir, `review-${statuses.join('-')}.json`);
  await writeFile(file, JSON.stringify({
    schema: 'pilotdeck-qa-review/v1',
    artifactSha256: artifactSha,
    pageCount,
    reviewer: 'human',
    pages: statuses.map((status, index) => ({ page: index + 1, status })),
  }));
  return file;
}

test('sample records validate', () => {
  assert.equal(cli('validate-acceptance', path.join(samples, 'acceptance.docx.example.json')).status, 0);
  assert.equal(cli('validate-report', path.join(samples, 'report.example.json')).status, 0);
});

test('a fully reviewed artifact passes and records the page matrix', async (t) => {
  const f = await fixture(t);
  const review = await writeReview(f.dir, { artifactSha: f.sha256 });
  const built = cli('build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--review', review,
    '--checks', await writeChecks(f.dir, { structural: 'passed', content: 'passed' }),
    '--now', '2026-11-09T00:00:00+00:00');
  assert.equal(built.status, 0, built.text);
  assert.equal(built.data.status, 'passed');
  assert.deepEqual(built.data.review.pageMatrix,
    { pages: 2, passed: 2, failed: 0, not_performed: 0 });

  const saved = path.join(f.dir, 'report.json');
  await writeFile(saved, JSON.stringify(built.data));
  assert.equal(cli('validate-report', saved).status, 0);
});

test('an unperformed page downgrades to passed_with_warnings', async (t) => {
  const f = await fixture(t);
  const review = await writeReview(f.dir, { artifactSha: f.sha256, statuses: ['passed', 'not_performed'] });
  const built = cli('build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--review', review,
    '--checks', await writeChecks(f.dir, { structural: 'passed', content: 'passed' }));
  assert.equal(built.data.status, 'passed_with_warnings');
  assert.equal(built.data.checks.visual, 'not_performed');
});

test('a failed page or failed structural check is a failure', async (t) => {
  const f = await fixture(t);
  const review = await writeReview(f.dir, { artifactSha: f.sha256, statuses: ['passed', 'failed'] });
  const visual = cli('build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--review', review,
    '--checks', await writeChecks(f.dir, { structural: 'passed', content: 'passed' }));
  assert.equal(visual.data.status, 'failed');

  const okReview = await writeReview(f.dir, { artifactSha: f.sha256 });
  const structural = cli('build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--review', okReview,
    '--checks', await writeChecks(f.dir, { structural: 'failed', content: 'passed' }));
  assert.equal(structural.data.status, 'failed');
});

test('review must match the artifact hash and cover every page', async (t) => {
  const f = await fixture(t);
  const stale = await writeReview(f.dir, { artifactSha: 'f'.repeat(64) });
  const mismatch = cli('build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--review', stale);
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.data.code, 'review-artifact-mismatch');

  const partial = path.join(f.dir, 'partial.json');
  await writeFile(partial, JSON.stringify({
    schema: 'pilotdeck-qa-review/v1',
    artifactSha256: f.sha256,
    pageCount: 3,
    pages: [{ page: 1, status: 'passed' }, { page: 3, status: 'passed' }],
  }));
  const incomplete = cli('validate-review', partial, '--artifact', f.artifact);
  assert.equal(incomplete.status, 1);
  assert.equal(incomplete.data.code, 'review-incomplete');

  const duplicate = path.join(f.dir, 'duplicate.json');
  await writeFile(duplicate, JSON.stringify({
    schema: 'pilotdeck-qa-review/v1',
    artifactSha256: f.sha256,
    pageCount: 2,
    pages: [{ page: 1, status: 'passed' }, { page: 1, status: 'passed' }],
  }));
  const dup = cli('validate-review', duplicate, '--artifact', f.artifact);
  assert.equal(dup.data.code, 'review-duplicate-page');
});

test('missing assets are reported as their own delivery state', async (t) => {
  const f = await fixture(t);
  const review = await writeReview(f.dir, { artifactSha: f.sha256 });
  const missing = path.join(f.dir, 'missing.json');
  await writeFile(missing, JSON.stringify([{ value: 'assets/ct.png', reason: '文件不存在' }]));
  const built = cli('build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--review', review,
    '--checks', await writeChecks(f.dir, { structural: 'passed', content: 'passed' }),
    '--missing-assets', missing);
  assert.equal(built.data.status, 'delivered_with_missing_assets');
  assert.equal(built.data.checks.assets, 'missing');
});

test('a forged passed report is rejected', async () => {
  const report = JSON.parse(await readFile(path.join(samples, 'report.example.json'), 'utf8'));
  const forged = {
    ...report,
    checks: { ...report.checks, visual: 'not_performed' },
  };
  const file = path.join(os.tmpdir(), `qa-forged-${process.pid}.json`);
  await writeFile(file, JSON.stringify(forged));
  const result = cli('validate-report', file);
  await rm(file, { force: true });
  assert.equal(result.status, 1);
  assert.equal(result.data.code, 'report-status-conflict');
});

test('builds are deterministic when the timestamp is fixed', async (t) => {
  const f = await fixture(t);
  const review = await writeReview(f.dir, { artifactSha: f.sha256 });
  const checks = await writeChecks(f.dir, { structural: 'passed', content: 'passed' });
  const args = ['build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--review', review, '--checks', checks,
    '--now', '2026-11-09T00:00:00+00:00'];
  const first = cli(...args).data;
  const second = cli(...args).data;
  assert.deepEqual(first, second);
});

test('visual=passed needs a review matrix or carried-over evidence', async (t) => {
  const f = await fixture(t);
  const checks = await writeChecks(f.dir, { structural: 'passed', content: 'passed' });
  const bare = path.join(f.dir, 'checks-visual-passed.json');
  await writeFile(bare, JSON.stringify({
    structural: 'passed', content: 'passed', visual: 'passed', assets: 'complete',
  }));
  const unsupported = cli('build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--checks', bare);
  assert.equal(unsupported.status, 1);
  assert.equal(unsupported.data.code, 'visual-evidence-missing');

  const evidence = path.join(f.dir, 'visual-evidence.json');
  await writeFile(evidence, JSON.stringify({
    source: 'docx-preflight',
    kind: 'legacy-visual-review',
    report: 'qa/visual-review.json',
    pagesReviewed: [1, 2],
    artifactSha256: f.sha256,
  }));
  const built = cli('build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--checks', bare,
    '--visual-evidence', evidence, '--now', '2026-11-09T00:00:00+00:00');
  assert.equal(built.status, 0, built.text);
  assert.equal(built.data.status, 'passed');
  assert.equal(built.data.visualEvidence.pagesReviewed.length, 2);

  const stale = path.join(f.dir, 'visual-evidence-stale.json');
  await writeFile(stale, JSON.stringify({
    source: 'docx-preflight', report: 'qa/visual-review.json',
    pagesReviewed: [1], artifactSha256: 'f'.repeat(64),
  }));
  const mismatch = cli('build', '--skill', 'docx', '--artifact', f.artifact,
    '--acceptance', f.acceptance, '--checks', bare, '--visual-evidence', stale);
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.data.code, 'visual-evidence-artifact-mismatch');
  assert.ok(checks);
});

test('a passed report without any visual evidence is rejected', async () => {
  const report = JSON.parse(await readFile(path.join(samples, 'report.example.json'), 'utf8'));
  const stripped = { ...report, review: null };
  const file = path.join(os.tmpdir(), `qa-no-evidence-${process.pid}.json`);
  await writeFile(file, JSON.stringify(stripped));
  const result = cli('validate-report', file);
  await rm(file, { force: true });
  assert.equal(result.status, 1);
  assert.equal(result.data.code, 'report-evidence-missing');
});

async function writeChecks(dir, checks) {
  const file = path.join(dir, `checks-${checks.structural}-${checks.content}.json`);
  await writeFile(file, JSON.stringify({ ...checks, assets: 'complete' }));
  return file;
}
