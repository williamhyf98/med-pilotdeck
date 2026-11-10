import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = path.join(repo, 'skills/pptx/scripts/pptx.sh');
const fixture = path.join(repo, 'tests/skill-e2e/local-fixtures/t0/pptx-content.md');
const runtime = path.join(repo, '.runtime');
const baseEnv = {
  ...process.env,
  PATH: `${path.join(runtime, 'node/bin')}:${process.env.PATH ?? ''}`,
  XDG_CACHE_HOME: path.join(runtime, 'cache/xdg'),
  PILOTDECK_OFFICE_RENDERER_URL: '',
};

function cli(env, ...args) {
  return execFileSync('bash', [wrapper, ...args], { encoding: 'utf8', env });
}

function json(env, ...args) {
  return JSON.parse(cli(env, ...args));
}

function slides(file) {
  const xml = execFileSync('unzip', ['-p', file, 'ppt/slides/slide1.xml'], { encoding: 'utf8' });
  const count = Number(execFileSync('unzip', ['-p', file, 'docProps/app.xml'], { encoding: 'utf8' })
    .match(/<Slides>(\d+)<\/Slides>/)?.[1] ?? 0);
  assert.ok(count > 0, `no slides in ${file}`);
  return { xml, count };
}

function pageXml(file, number) {
  return execFileSync('unzip', ['-p', file, `ppt/slides/slide${number}.xml`], { encoding: 'utf8' });
}

test('the cover takes its structure from the theme masthead, one family per structure', async (t) => {
  if (spawnSync('bash', [wrapper, 'check'], { env: baseEnv, encoding: 'utf8' }).status !== 0) {
    t.skip('bundled PPTX runtime is unavailable');
    return;
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-pptx-covers-'));
  const env = { ...baseEnv, PILOTDECK_WORK_DIR: path.join(temp, 'work') };
  const cover = (theme) => {
    const out = path.join(temp, `${theme}.pptx`);
    const result = json(env, 'make', '--title', '封面结构验证', '--markdown', fixture,
      '--out', out, '--theme', theme, '--force');
    assert.equal(result.status, 'ok');
    return slides(out).xml;
  };
  try {
    await mkdir(path.join(temp, 'work'), { recursive: true });
    const covers = {
      clinical: cover('clinical'),
      academic: cover('academic'),
      trauma: cover('trauma'),
      archive: cover('archive'),
      edu: cover('edu'),
      mono: cover('mono'),
    };

    // each masthead family must leave its own fingerprint on page 1
    assert.match(covers.academic, /name="Cover Band"/);
    assert.match(covers.trauma, /name="Cover Edge Bar"/);
    assert.match(covers.archive, /name="Cover Frame"/);
    assert.match(covers.edu, /name="Cover Card"/);
    assert.match(covers.clinical, /name="Title Accent"/);
    assert.doesNotMatch(covers.clinical, /name="Cover Ruler"/);
    // mono has its own masthead value, so the ruler never leaks into clinical
    assert.match(covers.mono, /name="Cover Ruler"/);
    assert.doesNotMatch(covers.mono, /name="Title Accent"/);

    const distinct = new Set(Object.values(covers));
    assert.equal(distinct.size, 6, '六套主题的封面形状结构必须两两不同');

    // the same switch drives content pages, not just the cover
    const contentPage = (theme, number) => pageXml(path.join(temp, `${theme}.pptx`), number);
    assert.match(contentPage('mono', 3), /name="Masthead Rule 1"/);
    assert.match(contentPage('mono', 3), /name="Masthead Rule 2"/);
    assert.doesNotMatch(contentPage('mono', 3), /name="Title Rule"/);
    assert.match(contentPage('clinical', 3), /name="Title Rule"/);
    assert.doesNotMatch(contentPage('clinical', 3), /name="Masthead Rule 1"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('six public themes are listed, hidden legacy palettes are not', (t) => {
  const check = spawnSync('bash', [wrapper, 'check'], { env: baseEnv, encoding: 'utf8' });
  if (check.status !== 0) {
    t.skip('bundled PPTX runtime is unavailable');
    return;
  }
  const result = json(baseEnv, 'themes');
  assert.equal(result.status, 'ok');
  assert.equal(result.defaultRefresh, 'approved-2026-11-10');
  assert.deepEqual(result.themes.map((item) => item.name),
    ['clinical', 'academic', 'trauma', 'archive', 'edu', 'mono']);
  assert.deepEqual(result.themes.map((item) => item.label),
    ['临床晨光', '青黛循证', '松风急救', '宣纸病案', '杏林宣教', '灰阶印刷']);
  assert.equal(result.themes.filter((item) => item.default).length, 1);
});

test('the default theme is clinical and legacy palettes stay reproducible', async (t) => {
  if (spawnSync('bash', [wrapper, 'check'], { env: baseEnv, encoding: 'utf8' }).status !== 0) {
    t.skip('bundled PPTX runtime is unavailable');
    return;
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-pptx-themes-'));
  const env = { ...baseEnv, PILOTDECK_WORK_DIR: path.join(temp, 'work') };
  const build = (name, theme) => {
    const out = path.join(temp, `${name}.pptx`);
    const args = ['make', '--title', '交班信息整理', '--markdown', fixture, '--out', out, '--force'];
    if (theme) args.push('--theme', theme);
    return { out, result: json(env, ...args) };
  };
  try {
    await mkdir(path.join(temp, 'work'), { recursive: true });
    const plain = build('plain');
    const explicitClinical = build('explicit-clinical', 'clinical');
    const legacy = build('legacy', 'clinical-legacy');
    const academic = build('academic', 'academic');
    const chinese = build('chinese', '青黛循证');
    const alias = build('alias', '学术');
    const archive = build('archive', 'archive');
    const vital = build('vital', 'vital');
    const vitalLegacy = build('vital-legacy', 'vital-legacy');
    const legacyBuilder = path.join(temp, 'legacy-builder.pptx');
    json(env, 'build', '--builder', path.join(repo, 'skills/pptx/assets/cjk-self-test-deck.mjs'),
      '--out', legacyBuilder, '--theme', 'vital-legacy');

    const { count } = slides(plain.out);
    assert.ok(count >= 3);
    assert.equal(plain.result.theme, 'clinical', 'a deck built without --theme must use clinical');
    assert.equal(plain.result.themeLabel, '临床晨光');
    for (let number = 1; number <= count; number += 1) {
      assert.equal(pageXml(explicitClinical.out, number), pageXml(plain.out, number));
    }
    assert.equal(legacy.result.theme, 'clinical-legacy');
    assert.notEqual(pageXml(legacy.out, 1), pageXml(plain.out, 1),
      'the legacy palette must not equal the refreshed default');
    assert.match(pageXml(legacy.out, 1), /<a:srgbClr val="102A43"/);
    assert.notEqual(pageXml(academic.out, 1), pageXml(plain.out, 1));
    assert.equal(chinese.result.theme, 'academic');
    assert.equal(chinese.result.themeLabel, '青黛循证');
    for (let number = 1; number <= count; number += 1) {
      assert.equal(pageXml(chinese.out, number), pageXml(academic.out, number));
      assert.equal(pageXml(alias.out, number), pageXml(academic.out, number));
    }

    const archiveXml = slides(archive.out).xml;
    // serif themes ask for SimSun, which Windows ships and Office for Mac
    // bundles as Simsun.ttc — a name every target machine can resolve.
    assert.match(archiveXml, /<a:ea typeface="SimSun"/);
    assert.match(archiveXml, /<a:latin typeface="SimSun"/);

    assert.equal(vital.result.theme, 'clinical');
    assert.match(vital.result.themeWarning, /vital-legacy/);
    const legacyVital = slides(vitalLegacy.out).xml;
    assert.match(legacyVital, /<a:srgbClr val="08333D"/);
    assert.match(legacyVital, /<a:srgbClr val="C2255C"/);
    // A hidden legacy palette keeps the old hardcoded on-dark colors and the
    // old Arial builder font, so it reproduces the pre-theme deck exactly.
    const legacyDeck = slides(legacyBuilder).xml;
    assert.match(legacyDeck, /<a:srgbClr val="C7D8E5"/);
    assert.match(legacyDeck, /<a:srgbClr val="D7E2EA"/);
    assert.match(legacyDeck, /<a:ea typeface="Arial"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('unknown theme names fail with the available Chinese labels', (t) => {
  if (spawnSync('bash', [wrapper, 'check'], { env: baseEnv, encoding: 'utf8' }).status !== 0) {
    t.skip('bundled PPTX runtime is unavailable');
    return;
  }
  const temp = os.tmpdir();
  const result = spawnSync('bash', [wrapper, 'make', '--title', 'x', '--body', '内容',
    '--theme', '不存在的主题', '--out', path.join(temp, `pilotdeck-unknown-${process.pid}.pptx`)],
  { encoding: 'utf8', env: { ...baseEnv, PILOTDECK_WORK_DIR: temp } });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /临床晨光|青黛循证/);
});
