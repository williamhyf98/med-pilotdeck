// T4.5: the deployment preflight must classify font resolution correctly and
// must never claim "ok" when a required runtime or the renderer is missing.
// Every case injects a fake runtime, so the test is deterministic and offline.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { preflight, REQUIRED_FONTS } from '../../scripts/platform-preflight.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const DEJAVU_SANS = 'DejaVu Sans|/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const DEJAVU_SERIF = 'DejaVu Serif|/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf';
const DEJAVU_MONO = 'DejaVu Sans Mono|/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const NOTO_SANS_SC = 'Noto Sans CJK SC|/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
const NOTO_SERIF_SC = 'Noto Serif CJK SC|/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc';
const NOTO_SANS_JP = 'Noto Sans CJK JP|/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';

/** A correctly provisioned Debian host with fonts-noto-cjk and LANG=zh_CN.UTF-8. */
const GOOD_FONTS = {
  'Noto Sans SC': NOTO_SANS_SC,
  'Microsoft YaHei': NOTO_SANS_SC,
  SimSun: NOTO_SERIF_SC,
  Consolas: DEJAVU_MONO,
  'Noto Sans CJK SC': NOTO_SANS_SC,
  'Noto Serif CJK SC': NOTO_SERIF_SC,
};

function runtimeWithFonts(map, overrides = {}) {
  const answers = { 'Noto Sans SC': DEJAVU_SANS, SimSun: DEJAVU_SERIF, Consolas: DEJAVU_MONO, ...map };
  const custom = overrides.run ?? {};
  return {
    platform: overrides.platform ?? 'linux',
    run: async (command, args) => {
      if (custom[command]) return custom[command](command, args);
      if (command === 'fc-match') {
        const family = args[args.length - 1];
        return { ok: true, stdout: answers[family] ?? DEJAVU_SANS };
      }
      if (command === 'node') return { ok: true, stdout: 'v22.11.0' };
      if (command === 'python3') return { ok: true, stdout: 'Python 3.11.2' };
      if (command === 'pdffonts') return { ok: true, stdout: 'pdffonts version 23.08.0' };
      return { ok: false, stdout: '', error: 'ENOENT' };
    },
    fetch: overrides.fetch ?? (async () => ({ ok: true, status: 200 })),
  };
}

test('a correctly provisioned Linux host reports ok', async () => {
  const report = await preflight({ runtime: runtimeWithFonts(GOOD_FONTS) });
  assert.equal(report.status, 'ok', JSON.stringify(report.issues));
  assert.equal(report.counts.errors, 0);
  assert.equal(report.counts.warnings, 0);
  assert.equal(report.tools.node, '22.11.0');
  assert.match(report.tools.python3, /3\.11/);
  assert.equal(report.visual_acceptance, 'not_performed');
});

test('a Japanese fallback is a warning, never a silent pass', async () => {
  const report = await preflight({
    runtime: runtimeWithFonts({
      ...GOOD_FONTS,
      'Microsoft YaHei': NOTO_SANS_JP,
      SimSun: NOTO_SANS_JP,
    }),
  });
  assert.equal(report.status, 'warning');
  const mismatch = report.issues.filter((item) => item.code === 'cjk-variant-mismatch');
  assert.ok(mismatch.length >= 2, JSON.stringify(report.issues));
  assert.match(mismatch[0].message, /zh_CN\.UTF-8|fontconfig/);
});

test('a host without any CJK font is flagged per family', async () => {
  const report = await preflight({ runtime: runtimeWithFonts({}) });
  assert.equal(report.status, 'warning');
  const cjk = report.fonts.filter((item) => item.expectsSc);
  assert.ok(cjk.length >= 3);
  for (const item of cjk) {
    assert.equal(item.status, 'warning', `${item.name} should be flagged`);
    assert.equal(item.code, 'no-cjk-face');
  }
  const mono = report.fonts.find((item) => item.name === 'Consolas');
  assert.equal(mono.status, 'ok', 'DejaVu Sans Mono is an acceptable mono face');
});

test('missing python3 or node is an error, never a pass', async () => {
  const runtime = runtimeWithFonts(GOOD_FONTS, {
    run: { python3: async () => ({ ok: false, stdout: '', error: 'ENOENT' }) },
  });
  const report = await preflight({ runtime });
  assert.equal(report.status, 'error');
  assert.ok(report.issues.some((item) => item.code === 'python-missing'));
  assert.equal(report.tools.python3, null);
});

test('without fc-match the font verdict is unknown, not assumed good', async () => {
  const runtime = runtimeWithFonts(GOOD_FONTS, {
    run: { 'fc-match': async () => ({ ok: false, stdout: '', error: 'ENOENT' }) },
  });
  const report = await preflight({ runtime });
  assert.equal(report.status, 'warning');
  for (const item of report.fonts) {
    assert.equal(item.status, 'unknown');
    assert.equal(item.code, 'fontconfig-missing');
  }
});

test('the renderer check separates skipped, reachable and unreachable', async () => {
  const skipped = await preflight({ runtime: runtimeWithFonts(GOOD_FONTS) });
  assert.equal(skipped.renderer.status, 'skipped');
  assert.equal(skipped.status, 'ok', 'a missing renderer is a skip, not a failure');

  const reachable = await preflight({
    runtime: runtimeWithFonts(GOOD_FONTS),
    renderer: 'http://10.31.112.13:19400',
  });
  assert.equal(reachable.renderer.status, 'ok');
  assert.equal(reachable.status, 'ok');

  const unreachable = await preflight({
    runtime: runtimeWithFonts(GOOD_FONTS, {
      fetch: async () => ({ ok: false, error: 'ECONNREFUSED' }),
    }),
    renderer: 'http://10.31.112.13:19400',
  });
  assert.equal(unreachable.renderer.status, 'error');
  assert.equal(unreachable.status, 'error');
  assert.match(unreachable.renderer.message, /不能当作通过/);
});

test('the probe list covers every font name the skills write', () => {
  const names = REQUIRED_FONTS.map((item) => item.name);
  for (const expected of ['Microsoft YaHei', 'SimSun', 'Consolas', 'Noto Sans CJK SC']) {
    assert.ok(names.includes(expected), `${expected} must be probed`);
  }
  assert.ok(REQUIRED_FONTS.every((item) => item.role));
});

test('a serif face replaced by a sans face is reported as serif-lost', async () => {
  const report = await preflight({
    runtime: runtimeWithFonts({
      ...GOOD_FONTS,
      SimSun: NOTO_SANS_SC,
      'Noto Serif CJK SC': NOTO_SANS_SC,
    }),
  });
  assert.equal(report.status, 'warning');
  const lost = report.issues.filter((item) => item.code === 'serif-lost').map((item) => item.message);
  assert.equal(lost.length, 2, JSON.stringify(report.issues));
  assert.match(lost[0], /需要衬线/);
});

test('the CLI entry point exits 0 on warnings and 2 on errors', () => {
  const run = spawnSync('node', [path.join(repo, 'scripts/platform-preflight.mjs'), '--json'], {
    cwd: repo, encoding: 'utf8',
  });
  // This machine may or may not have the CJK fonts; warnings must still exit 0.
  assert.ok([0, 2].includes(run.status), run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.ok(['ok', 'warning', 'error'].includes(payload.status));
  assert.equal(payload.visual_acceptance, 'not_performed');
  if (payload.status !== 'error') assert.equal(run.status, 0);
  if (payload.status === 'error') assert.equal(run.status, 2);
});
