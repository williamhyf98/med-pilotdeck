import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = path.join(repo, 'skills/docx/scripts/docx.sh');
const tokensFile = path.join(repo, 'skills/_shared/design-tokens.json');
const runtime = path.join(repo, '.runtime');

const tokens = JSON.parse(await readFile(tokensFile, 'utf8'));
const publicThemes = Object.entries(tokens.themes)
  .filter(([, theme]) => theme.status !== 'hidden')
  .map(([id, theme]) => ({ id, label: theme.label, aliases: theme.aliases, colors: theme.colors }));

const baseEnv = {
  ...process.env,
  PATH: `${path.join(runtime, 'node/bin')}:${process.env.PATH ?? ''}`,
  XDG_CACHE_HOME: path.join(runtime, 'cache/xdg'),
  PILOTDECK_OFFICE_RENDERER_URL: '',
};
delete baseEnv.PILOTDECK_WORK_DIR;

const runtimeReady = () => spawnSync('bash', [wrapper, 'check'], { env: baseEnv, encoding: 'utf8' }).status === 0;

function run(env, ...args) {
  return execFileSync('bash', [wrapper, ...args], { encoding: 'utf8', env });
}

function xml(file, part = 'word/document.xml') {
  return execFileSync('unzip', ['-p', file, part], { encoding: 'utf8' });
}

function colors(file) {
  const document = xml(file);
  return {
    text: new Set([...document.matchAll(/w:color w:val="([0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase())),
    fills: new Set([...document.matchAll(/w:fill="([0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase())),
    borders: new Set([...document.matchAll(/w:color="([0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase())),
  };
}

async function makeDoc(dir, name, ...args) {
  const out = path.join(dir, `${name}.docx`);
  run(baseEnv, 'make', '--title', '主题样张', '--body', '患者男性，58 岁，因胸痛入院。', '--out', out, '--force', ...args);
  return out;
}

async function expectError(dir, name, spec, code) {
  const specFile = path.join(dir, `${name}.json`);
  await writeFile(specFile, JSON.stringify(spec));
  const result = spawnSync(
    'bash',
    [wrapper, 'make', '--spec', specFile, '--out', path.join(dir, `${name}.docx`), '--force'],
    { env: baseEnv, encoding: 'utf8' },
  );
  const text = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `expected failure for ${name}`);
  assert.match(text, new RegExp(code));
}

test('neutral default stays black-and-white', async (t) => {
  if (!runtimeReady()) return t.skip('bundled DOCX runtime is unavailable');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'docx-theme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeDoc(dir, 'neutral');
  const found = colors(file);
  assert.deepEqual([...found.text], ['000000']);
  assert.equal(found.fills.size, 0);
});

test('every public theme id, label and alias resolves to the token palette', async (t) => {
  if (!runtimeReady()) return t.skip('bundled DOCX runtime is unavailable');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'docx-theme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const theme of publicThemes) {
    for (const name of [theme.id, theme.label, theme.aliases[0]]) {
      const file = await makeDoc(dir, `theme-${theme.id}-${encodeURIComponent(name)}`, '--design-theme', name);
      const found = colors(file);
      assert.ok(found.text.has(theme.colors.primary.toUpperCase()),
        `${theme.id} title/heading should use primary ${theme.colors.primary}`);
      for (const color of found.text) {
        assert.ok(
          [theme.colors.primary, theme.colors.onPrimary].includes(color),
          `${theme.id} unexpected text color ${color}`,
        );
      }
      const styles = xml(file, 'word/styles.xml');
      assert.match(styles, new RegExp(`w:color w:val="${theme.colors.ink.toUpperCase()}"`),
        `${theme.id} body should use ink`);
    }
  }
});

test('checklist boxes are real symbol glyphs, not ballot-box code points', async (t) => {
  if (!runtimeReady()) return t.skip('bundled DOCX runtime is unavailable');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'docx-checklist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const specFile = path.join(dir, 'checklist.json');
  await writeFile(specFile, JSON.stringify({
    content: [
      { type: 'heading', level: 1, text: '出院核对' },
      { type: 'checklist', items: ['已评估', '已交代'], checked: [true, false] },
    ],
  }));
  const out = path.join(dir, 'checklist.docx');
  run(baseEnv, 'make', '--spec', specFile, '--out', out, '--force');
  const document = xml(out);
  // Microsoft YaHei and SimSun have no U+2610/U+2611/U+2612, so literal
  // ballot-box characters degrade to an empty glyph in Word. Wingdings boxes
  // are what Word itself writes when you insert a symbol.
  assert.doesNotMatch(document, /[\u2610-\u2612]/, 'no ballot-box code points');
  const symbols = [...document.matchAll(/<w:sym w:font="([^"]+)" w:char="([^"]+)"\/>/g)]
    .map((match) => `${match[1]}:${match[2]}`);
  assert.deepEqual(symbols, ['Wingdings:F0FE', 'Wingdings:F0A8'],
    'checked and unchecked items must use different glyphs');
});

test('invalid theme policies are rejected with actionable codes', async (t) => {
  if (!runtimeReady()) return t.skip('bundled DOCX runtime is unavailable');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'docx-theme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const content = [{ type: 'paragraph', text: 'x' }];
  await expectError(dir, 'unknown', {
    style_policy: { mode: 'builtin', template: 'themed-v1', theme: 'no-such-theme' },
    content,
  }, 'invalid-design-theme');
  await expectError(dir, 'neutral-theme', {
    style_policy: { mode: 'builtin', template: 'neutral-document-v1', theme: 'clinical' },
    content,
  }, 'invalid-style-policy');
  await expectError(dir, 'missing-theme', {
    style_policy: { mode: 'builtin', template: 'themed-v1' },
    content,
  }, 'invalid-style-policy');
  await expectError(dir, 'user-theme', {
    style_policy: {
      mode: 'user',
      source: 'explicit-requirements',
      requirements: ['蓝色标题'],
      theme: 'clinical',
    },
    content,
  }, 'invalid-style-policy');
});

test('frozen acceptance manifest stores the canonical theme id', async (t) => {
  if (!runtimeReady()) return t.skip('bundled DOCX runtime is unavailable');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'docx-theme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const work = path.join(dir, 'work');
  await mkdir(work, { recursive: true });
  const env = { ...baseEnv, PILOTDECK_WORK_DIR: work };
  run(env, 'prepare', '--style-mode', 'builtin', '--design-theme', '青黛循证');
  const acceptance = JSON.parse(await readFile(path.join(work, 'docx/qa/acceptance.json'), 'utf8'));
  assert.deepEqual(acceptance.style_policy, {
    mode: 'builtin',
    template: 'themed-v1',
    theme: 'academic',
  });
});
