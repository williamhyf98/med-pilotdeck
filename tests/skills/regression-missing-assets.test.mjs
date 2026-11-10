// T5.3: what each format does when a referenced asset is missing.
//
// Two contracts matter here and they differ by format:
//   * text formats (DOCX/PDF/PPTX-with-path/HTML) must fail loudly, never ship
//     a document that silently drops the picture the user asked for;
//   * PPTX imaging without any image field is an intentional placeholder and
//     must succeed with a visible "影像未提供" label.
//
// The PDF CLI reports failures as JSON but keeps exit code 0, so the PDF case
// asserts on the payload rather than on the process status.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrappers = {
  pptx: path.join(repo, 'skills/pptx/scripts/pptx.sh'),
  docx: path.join(repo, 'skills/docx/scripts/docx.sh'),
  pdf: path.join(repo, 'skills/pdf/scripts/pdf.sh'),
  html: path.join(repo, 'skills/frontend-slides/scripts/html.sh'),
};

const env = {
  ...process.env,
  PATH: `${path.join(repo, '.runtime/node/bin')}:${process.env.PATH ?? ''}`,
  XDG_CACHE_HOME: path.join(repo, '.runtime/cache/xdg'),
  PILOTDECK_OFFICE_RENDERER_URL: '',
};
delete env.PILOTDECK_WORK_DIR;

const MISSING = '/nonexistent/regression-fixture/missing.png';

function run(wrapper, args) {
  const result = spawnSync('bash', [wrapper, ...args], { env, encoding: 'utf8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  let json = null;
  // DOCX writes its failure payload to stderr, PDF to stdout; accept either.
  for (const channel of [stdout, stderr]) {
    try {
      json = JSON.parse(channel);
      break;
    } catch {
      // try the next channel
    }
  }
  return { status: result.status, json, text: `${stdout}${stderr}` };
}

const ready = (name) => run(wrappers[name], ['check']).status === 0;

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'missing-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const SKIP = {
  docx: ready('docx') ? false : 'docx runtime not installed',
  pdf: ready('pdf') ? false : 'pdf runtime not installed',
  pptx: ready('pptx') ? false : 'pptx runtime not installed',
  html: ready('html') ? false : 'html runtime not installed',
};

test('DOCX refuses to build when an image path does not exist', { skip: SKIP.docx }, async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    metadata: { title: '缺图用例' },
    content: [
      { type: 'heading', level: 1, text: '缺图用例' },
      { type: 'image', path: MISSING },
    ],
  }));
  const made = run(wrappers.docx, ['make', '--spec', spec, '--out', path.join(dir, 'a.docx'), '--force']);
  assert.notEqual(made.status, 0, 'a missing image must fail the build');
  assert.equal(made.json?.status, 'error', made.text);
  assert.equal(made.json?.code, 'image-not-found', made.text);
});

test('PDF reports a missing image instead of dropping it', { skip: SKIP.pdf }, async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '缺图用例',
    body: '患者男性，58 岁，因胸痛三小时入院。',
    images: [{ type: 'image', path: MISSING, caption: '图 1' }],
  }));
  const made = run(wrappers.pdf, ['make', '--spec', spec, '--out', path.join(dir, 'a.pdf'), '--force']);
  // The CLI keeps exit code 0 and puts the failure in the payload.
  assert.equal(made.json?.status, 'error', made.text);
  assert.match(String(made.json?.error ?? ''), /image not found/u, made.text);
});

test('PPTX imaging without an image field draws the labelled placeholder', { skip: SKIP.pptx }, async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '影像缺失',
    slides: [{ type: 'imaging', title: '胸部 CT', findings: ['待补充'], impression: '待补充' }],
  }));
  const out = path.join(dir, 'placeholder.pptx');
  const made = run(wrappers.pptx, ['make', '--spec', spec, '--out', out, '--force']);
  assert.equal(made.status, 0, made.text);
  const xml = execFileSync('unzip', ['-p', out, 'ppt/slides/slide2.xml'], { encoding: 'utf8' });
  assert.match(xml, /Imaging Placeholder/u);
  assert.match(xml, /影像未提供/u);
});

test('PPTX imaging with a broken image path fails the build', { skip: SKIP.pptx }, async (t) => {
  const dir = await tempDir(t);
  const spec = path.join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    title: '影像缺失',
    slides: [{
      type: 'imaging',
      title: '胸部 CT',
      image: { path: MISSING, caption: '图 1' },
      findings: ['待补充'],
      impression: '待补充',
    }],
  }));
  const made = run(wrappers.pptx, ['make', '--spec', spec, '--out', path.join(dir, 'broken.pptx'), '--force']);
  assert.notEqual(made.status, 0, 'a broken imaging path must fail the build');
  assert.match(made.text, /ENOENT|Unable to read media/u, made.text);
});

test('HTML audit flags a reference to a file that is not next to the page', { skip: SKIP.html }, async (t) => {
  const dir = await tempDir(t);
  const page = path.join(dir, 'page.html');
  await writeFile(page, [
    '<!doctype html>',
    '<html lang="zh-CN" data-pd-theme="archive">',
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>缺图用例</title></head>',
    '<body><h1>缺图用例</h1>',
    '<img src="missing.png" alt="缺失的影像">',
    '</body></html>',
  ].join('\n'));
  const audited = run(wrappers.html, ['audit', page]);
  assert.equal(audited.json?.status, 'error', audited.text);
  assert.equal(audited.json?.counts?.missing, 1, audited.text);
  const codes = (audited.json?.issues ?? []).map((issue) => issue.code);
  assert.ok(codes.includes('missing-resource'), `expected missing-resource, got ${codes.join(', ')}`);
});
