import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = path.join(repo, 'skills/pptx/scripts/pptx.sh');
const builder = path.join(repo, 'skills/pptx/assets/cjk-self-test-deck.mjs');
const fixture = path.join(repo, 'tests/skill-e2e/local-fixtures/t0/pptx-content.md');
const runtime = path.join(repo, '.runtime');
const env = {
  ...process.env,
  PATH: `${path.join(runtime, 'node/bin')}:${process.env.PATH ?? ''}`,
  XDG_CACHE_HOME: path.join(runtime, 'cache/xdg'),
  PILOTDECK_OFFICE_RENDERER_URL: '',
};

function run(...args) {
  return execFileSync('bash', [wrapper, ...args], { encoding: 'utf8', env });
}

function slideXml(file, number = 1) {
  return execFileSync('unzip', ['-p', file, `ppt/slides/slide${number}.xml`], { encoding: 'utf8' });
}

function slideFonts(file) {
  const xml = slideXml(file);
  return {
    latin: [...xml.matchAll(/<a:latin typeface="([^"]+)"/g)].map((match) => match[1]),
    ea: [...xml.matchAll(/<a:ea typeface="([^"]+)"/g)].map((match) => match[1]),
  };
}

test('explicit Chinese builder theme uses shared sans role without changing old defaults', async (t) => {
  if (spawnSync('bash', [wrapper, 'check'], { env, encoding: 'utf8' }).status !== 0) {
    t.skip('bundled PPTX runtime is unavailable');
    return;
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-pptx-fonts-'));
  try {
    const oldBuilder = path.join(temp, 'old-builder.pptx');
    const legacyBuilder = path.join(temp, 'legacy-builder.pptx');
    const themedBuilder = path.join(temp, 'themed-builder.pptx');
    const vitalBuilder = path.join(temp, 'vital-builder.pptx');
    const oldMake = path.join(temp, 'old-make.pptx');
    run('build', '--builder', builder, '--out', oldBuilder);
    run('build', '--builder', builder, '--out', legacyBuilder, '--theme', 'clinical-legacy');
    run('build', '--builder', builder, '--out', themedBuilder, '--theme', 'academic');
    run('build', '--builder', builder, '--out', vitalBuilder, '--theme', 'vital-legacy');
    run('make', '--markdown', fixture, '--out', oldMake);

    const shared = JSON.parse(await readFile(path.join(repo, 'skills/_shared/design-tokens.json'), 'utf8'));
    // OOXML carries a font name, so we write the one Windows and Office for Mac
    // both ship, not the Noto name only the Linux renderer has.
    const sans = shared.fontRoles.sans.officeWindows;
    // D1: a builder that does not pass --theme now lands on the clinical
    // default, so it takes the shared sans role like any other deck.
    const defaultBuild = slideFonts(oldBuilder);
    assert.ok(defaultBuild.ea.length > 0);
    assert.ok(defaultBuild.ea.every((face) => face === sans), `default ea fonts: ${defaultBuild.ea}`);
    // The pre-theme Arial baseline is still reachable through the hidden
    // legacy palette.
    const baseline = slideFonts(legacyBuilder);
    assert.ok(baseline.ea.length > 0);
    assert.ok(baseline.ea.every((face) => face === 'Arial'));
    assert.ok(slideFonts(vitalBuilder).ea.every((face) => face === 'Arial'));
    const themed = slideFonts(themedBuilder);
    assert.ok(themed.ea.length > 0);
    assert.ok(themed.latin.length > 0);
    assert.ok(themed.ea.every((face) => face === sans), `Chinese ea fonts: ${themed.ea}`);
    assert.ok(themed.latin.every((face) => face === sans), `Latin fonts: ${themed.latin}`);
    const make = slideFonts(oldMake);
    assert.ok(make.ea.length > 0);
    assert.ok(make.ea.every((face) => face === sans), `unthemed ea fonts: ${make.ea}`);
    assert.ok(make.latin.every((face) => face === sans), `unthemed latin fonts: ${make.latin}`);

    const oldXml = slideXml(legacyBuilder);
    const themedXml = slideXml(themedBuilder);
    assert.match(oldXml, /<a:srgbClr val="C7D8E5"/);
    assert.match(oldXml, /<a:srgbClr val="D7E2EA"/);
    assert.match(oldXml, /<a:srgbClr val="A9BECC"/);
    assert.match(slideXml(vitalBuilder), /<a:srgbClr val="A9BECC"/);
    // `academic` uses the solid-band cover: a primary band carries the title in
    // onPrimary, the light half below carries the subtitle in ink, and only the
    // eyebrow sits on the band and needs onDarkMuted. The old onDark subtitle
    // colour belonged to the flat cover that predates the band layout.
    assert.match(themedXml, new RegExp(`<a:srgbClr val="${shared.themes.academic.colors.onPrimary}"`),
      '封面标题用 onPrimary');
    assert.match(themedXml, new RegExp(`<a:srgbClr val="${shared.themes.academic.colors.onDarkMuted}"`),
      '色带上的 eyebrow 用 onDarkMuted');
    assert.match(themedXml, new RegExp(`<a:srgbClr val="${shared.themes.academic.colors.ink}"`),
      '浅色半幅上的副标题用 ink');
    assert.doesNotMatch(themedXml, /<a:srgbClr val="(C7D8E5|D7E2EA|A9BECC)"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('a copied skill without the shared reader keeps generation available and reports fallback', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-pptx-override-'));
  const skill = path.join(temp, 'pptx');
  const previous = process.env.PPTX_SKILL_ROOT;
  const previousBundle = process.env.PILOTDECK_BUNDLED_SKILLS_DIR;
  try {
    await mkdir(path.join(skill, 'assets/layout-library'), { recursive: true });
    await copyFile(path.join(repo, 'skills/pptx/assets/layout-library/design-tokens.json'),
      path.join(skill, 'assets/layout-library/design-tokens.json'));
    process.env.PPTX_SKILL_ROOT = skill;
    process.env.PILOTDECK_BUNDLED_SKILLS_DIR = path.join(temp, 'missing-bundle');
    const { resolveDesignTokens } = await import(pathToFileURL(
      path.join(repo, 'skills/pptx/scripts/lib/toolkit.mjs')).href);
    const result = await resolveDesignTokens({
      lang: 'zh-CN', profile: 'cross-platform-zh', theme: 'academic',
    });
    assert.equal(result.typography.headFontFace, 'Microsoft YaHei');
    assert.equal(result.typography.bodyFontFace, 'Microsoft YaHei');
    assert.match(result.fontFallback, /shared theme reader is missing/);
    assert.equal(result.colors.onDark, undefined);
  } finally {
    if (previous === undefined) delete process.env.PPTX_SKILL_ROOT;
    else process.env.PPTX_SKILL_ROOT = previous;
    if (previousBundle === undefined) delete process.env.PILOTDECK_BUNDLED_SKILLS_DIR;
    else process.env.PILOTDECK_BUNDLED_SKILLS_DIR = previousBundle;
    await rm(temp, { recursive: true, force: true });
  }
});
