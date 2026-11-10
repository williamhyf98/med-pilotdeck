import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = path.join(repo, 'skills/pptx/scripts/pptx.sh');
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

test('page texture is on by default, removable with --texture none, and never silently substituted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-texture-'));
  try {
    const specPath = path.join(dir, 'deck.json');
    await writeFile(specPath, JSON.stringify({
      title: '纹理验证',
      slides: [{ type: 'content', title: '要点', items: ['一', '二'] }],
    }), 'utf8');

    const on = JSON.parse(cli(baseEnv, 'make', '--spec', specPath, '--out', path.join(dir, 'on.pptx')));
    assert.equal(on.status, 'ok');
    assert.equal(on.texture, 'grain', 'default make must use the grain texture');

    const off = JSON.parse(cli(baseEnv, 'make', '--spec', specPath, '--out', path.join(dir, 'off.pptx'), '--texture', 'none'));
    assert.equal(off.status, 'ok');
    assert.equal(off.texture, undefined, '--texture none must fall back to the flat fill');

    const missing = (() => {
      try {
        cli(baseEnv, 'make', '--spec', specPath, '--out', path.join(dir, 'bad.pptx'), '--texture', 'nope');
        return null;
      } catch (error) {
        return error;
      }
    })();
    assert.ok(missing, 'an unknown texture must fail, not degrade silently');

    // the texture is a real bitmap embedded per slide, not just a returned token
    const zipped = (file) => {
      const out = execFileSync('unzip', ['-p', file, 'ppt/slides/slide1.xml'], { encoding: 'utf8' });
      return out.includes('Background Texture');
    };
    assert.equal(zipped(path.join(dir, 'on.pptx')), true, 'slide XML must carry the texture picture');
    assert.equal(zipped(path.join(dir, 'off.pptx')), false, 'flat fill must stay free of the texture picture');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
