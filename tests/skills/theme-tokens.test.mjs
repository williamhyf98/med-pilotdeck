import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { listThemes, recommendTheme, resolveTheme } from '../../skills/_shared/tokens.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shared = path.join(repo, 'skills/_shared');
const checker = path.join(repo, 'scripts/check-skill-tokens.mjs');
const python = process.env.PILOTDECK_TEST_PYTHON ?? 'python3';

function pythonJson(...args) {
  return JSON.parse(execFileSync(python, [path.join(shared, 'tokens.py'), ...args], { encoding: 'utf8' }));
}

test('six public themes, names and aliases agree across Node and Python', async () => {
  const node = await listThemes();
  const py = pythonJson('--list');
  assert.equal(node.themes.length, 6);
  assert.deepEqual(py.themes, node.themes);
  assert.equal(node.source, path.join(shared, 'design-tokens.json'));

  for (const item of node.themes) {
    for (const name of [item.id, item.label, ...item.aliases]) {
      const selected = await resolveTheme(name);
      const other = pythonJson('--theme', name);
      assert.equal(selected.id, item.id);
      assert.deepEqual(other.theme, selected.theme);
      assert.equal(other.warning, selected.warning);
    }
  }
  assert.match((await resolveTheme('vital')).warning, /vital-legacy/);
  assert.equal((await resolveTheme('vital-legacy')).theme.status, 'hidden');
  assert.deepEqual((await recommendTheme(['meta-analysis'])).id,
    pythonJson('--recommend', 'meta-analysis').id);
  assert.equal((await recommendTheme(['unknown-task'])).id, 'clinical');
});

test('bundled root precedes the local sibling; missing data gives an explicit fallback', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-themes-'));
  try {
    const bundled = path.join(temp, 'bundle/_shared');
    await mkdir(bundled, { recursive: true });
    const altered = JSON.parse(await readFile(path.join(shared, 'design-tokens.json'), 'utf8'));
    altered.themes.clinical.label = '临时优先级测试';
    await writeFile(path.join(bundled, 'design-tokens.json'), JSON.stringify(altered));
    const selected = await resolveTheme('clinical', { bundledSkillsRoot: path.join(temp, 'bundle') });
    assert.equal(selected.theme.label, '临时优先级测试');
    const pythonSelected = JSON.parse(execFileSync(python, [path.join(shared, 'tokens.py'), '--theme', 'clinical'],
      { encoding: 'utf8', env: { ...process.env, PILOTDECK_BUNDLED_SKILLS_DIR: path.join(temp, 'bundle') } }));
    assert.equal(pythonSelected.theme.label, selected.theme.label);

    const isolated = path.join(temp, 'isolated/_shared');
    await mkdir(isolated, { recursive: true });
    await copyFile(path.join(shared, 'tokens.mjs'), path.join(isolated, 'tokens.mjs'));
    await copyFile(path.join(shared, 'tokens.py'), path.join(isolated, 'tokens.py'));
    const isolatedNode = await import(pathToFileURL(path.join(isolated, 'tokens.mjs')).href);
    const fallback = await isolatedNode.loadTokens({ bundledSkillsRoot: path.join(temp, 'isolated') });
    assert.equal(fallback.source, 'builtin-fallback');
    assert.match(fallback.reason, /missing/);
    const pythonFallback = JSON.parse(execFileSync(python, [path.join(isolated, 'tokens.py'), '--list'],
      { encoding: 'utf8', env: { ...process.env, PILOTDECK_BUNDLED_SKILLS_DIR: path.join(temp, 'isolated') } }));
    assert.equal(pythonFallback.source, 'builtin-fallback');
    assert.equal(pythonFallback.themes[0].id, 'clinical');

    const userSibling = path.join(temp, 'user-scope/_shared');
    await mkdir(userSibling, { recursive: true });
    await copyFile(path.join(shared, 'design-tokens.json'), path.join(userSibling, 'design-tokens.json'));
    const userSkillRoot = path.join(temp, 'user-scope/pptx');
    const nodeSibling = await isolatedNode.loadTokens({
      bundledSkillsRoot: path.join(temp, 'isolated'), skillRoot: userSkillRoot,
    });
    assert.equal(nodeSibling.source, await realpath(path.join(userSibling, 'design-tokens.json')));
    const pythonSibling = JSON.parse(execFileSync(python, ['-c',
      'import importlib.util,json,sys; spec=importlib.util.spec_from_file_location("tokens",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(json.dumps(m.load_tokens(bundled_skills_root=sys.argv[2],skill_root=sys.argv[3])))',
      path.join(isolated, 'tokens.py'), path.join(temp, 'isolated'), userSkillRoot],
    { encoding: 'utf8' }));
    assert.equal(pythonSibling.source, nodeSibling.source);

    await writeFile(path.join(isolated, 'design-tokens.json'), '{"schemaVersion":999}');
    await assert.rejects(isolatedNode.loadTokens({ bundledSkillsRoot: path.join(temp, 'isolated') }),
      /Unsupported theme schemaVersion/);
    const pythonInvalid = spawnSync(python, [path.join(isolated, 'tokens.py'), '--list'],
      { encoding: 'utf8', env: { ...process.env, PILOTDECK_BUNDLED_SKILLS_DIR: path.join(temp, 'isolated') } });
    assert.notEqual(pythonInvalid.status, 0);
    assert.match(pythonInvalid.stderr, /Unsupported theme schemaVersion/);
    await writeFile(path.join(isolated, 'design-tokens.json'), '{invalid');
    await assert.rejects(isolatedNode.loadTokens({ bundledSkillsRoot: path.join(temp, 'isolated') }),
      /Invalid theme JSON/);
    await writeFile(path.join(isolated, 'design-tokens.json'), '{"schemaVersion":2,"themes":{"clinical":{}},"defaultTheme":"clinical"}');
    await assert.rejects(isolatedNode.loadTokens({ bundledSkillsRoot: path.join(temp, 'isolated') }),
      /Incomplete theme data/);
    const pythonIncomplete = spawnSync(python, [path.join(isolated, 'tokens.py'), '--list'],
      { encoding: 'utf8', env: { ...process.env, PILOTDECK_BUNDLED_SKILLS_DIR: path.join(temp, 'isolated') } });
    assert.notEqual(pythonIncomplete.status, 0);
    assert.match(pythonIncomplete.stderr, /Incomplete theme data/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('data gate accepts current tokens and rejects semantic, alias and contrast regressions', async () => {
  const valid = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-token-check-'));
  try {
    const base = JSON.parse(await readFile(path.join(shared, 'design-tokens.json'), 'utf8'));
    base.themes.edu.aliases.push('学术');
    base.themes.clinical.colors.ink = 'FFFFFF';
    base.semantic.danger.fg = 'FFFFFF';
    const badFile = path.join(temp, 'bad.json');
    await writeFile(badFile, JSON.stringify(base));
    const invalid = spawnSync(process.execPath, [checker, badFile], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /duplicate theme name 学术/);
    assert.match(invalid.stderr, /clinical.ink\/paper/);
    assert.match(invalid.stderr, /semantic.danger.fg/);

    const legacyFile = path.join(temp, 'legacy.json');
    const legacy = JSON.parse(await readFile(path.join(shared, 'design-tokens.json'), 'utf8'));
    legacy.themes['vital-legacy'].colors.accent = '000000';
    await writeFile(legacyFile, JSON.stringify(legacy));
    const drift = spawnSync(process.execPath, [checker, legacyFile], { encoding: 'utf8' });
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /vital-legacy.accent/);

    const extraFile = path.join(temp, 'extra.json');
    const extra = JSON.parse(await readFile(path.join(shared, 'design-tokens.json'), 'utf8'));
    extra.themes.clinical.futureField = true;
    await writeFile(extraFile, JSON.stringify(extra));
    const forward = spawnSync(process.execPath, [checker, extraFile], { encoding: 'utf8' });
    assert.equal(forward.status, 0, forward.stderr);
    assert.match(forward.stderr, /unknown field/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
