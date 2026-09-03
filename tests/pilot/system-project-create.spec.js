// @ts-nocheck
/**
 * P0.1 smoke: createSystemProject uses typed id + nested layout.
 * Run: node --test tests/pilot/system-project-create.spec.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

test('createSystemProject writes typed meta and workspace dirs', async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), 'pilotdeck-sys-proj-'));
  const prev = process.env.PILOT_HOME;
  process.env.PILOT_HOME = pilotHome;
  try {
    const mod = await import(pathToFileURL(join(process.cwd(), 'ui/server/projects.js')).href);
    const general = await mod.createSystemProject({
      displayName: '测试-通用',
      type: mod.PROJECT_TYPES.GENERAL_MEDICINE,
    });
    assert.equal(general.displayName, '测试-通用');
    assert.equal(general.projectType, 'general_medicine');
    assert.match(general.name, /^general_med-/);
    assert.ok(
      general.fullPath.endsWith(join('workspaces', 'general_med', general.name)),
    );

    const metaRaw = await readFile(
      join(pilotHome, 'projects', 'general_med', general.name, 'meta.json'),
      'utf8',
    );
    const meta = JSON.parse(metaRaw);
    assert.equal(meta.type, 'general_medicine');
    assert.equal(meta.kind, 'system');
    assert.equal(meta.displayName, '测试-通用');
    assert.equal(meta.id, general.name);

    await access(join(pilotHome, 'workspaces', 'general_med', general.name, 'inbox'));
    await access(join(pilotHome, 'workspaces', 'general_med', general.name, 'exports'));
    await access(join(pilotHome, 'workspaces', 'general_med', general.name, 'scratch'));
    await access(join(pilotHome, 'projects', 'general_med', general.name, '.cwd'));
    await access(join(pilotHome, 'projects', 'general_med', general.name, 'chats'));

    const trauma = await mod.createSystemProject({
      displayName: '测试-战创伤',
      type: mod.PROJECT_TYPES.WAR_TRAUMA,
    });
    assert.equal(trauma.displayName, '测试-战创伤');
    assert.equal(trauma.projectType, 'war_trauma');
    assert.match(trauma.name, /^trauma_med-/);
    assert.ok(
      trauma.fullPath.endsWith(join('workspaces', 'trauma_med', trauma.name)),
    );
    await access(join(pilotHome, 'projects', 'trauma_med', trauma.name, 'chats'));
    await access(join(pilotHome, 'workspaces', 'trauma_med', trauma.name, 'inbox'));

    await assert.rejects(
      () => mod.createSystemProject({ displayName: 'x', type: 'invalid' }),
      /type must be/,
    );
    await assert.rejects(
      () => mod.createSystemProject({ displayName: '  ', type: 'general_medicine' }),
      /displayName/,
    );
  } finally {
    if (prev === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = prev;
    await rm(pilotHome, { recursive: true, force: true });
  }
});
