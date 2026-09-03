// @ts-nocheck
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runTraumaMigration } from '../../scripts/migrate-trauma-to-general.mjs';

async function write(path, content) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

test('retypes trauma projects, references, and skill availability into general medicine', async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), 'pilotdeck-trauma-migration-'));
  const oldId = 'trauma_med-example';
  const newId = 'general_med-example';
  const oldWorkspace = join(pilotHome, 'workspaces', 'trauma_med', oldId);
  const newWorkspace = join(pilotHome, 'workspaces', 'general_med', newId);

  try {
    await write(
      join(pilotHome, 'projects', 'trauma_med', oldId, 'meta.json'),
      `${JSON.stringify({ id: oldId, displayName: '旧战创伤项目', type: 'war_trauma', kind: 'system' }, null, 2)}\n`,
    );
    await write(join(pilotHome, 'projects', 'trauma_med', oldId, '.cwd'), oldWorkspace);
    await write(
      join(pilotHome, 'projects', 'trauma_med', oldId, 'chats', 'session.jsonl'),
      `${JSON.stringify({ path: oldWorkspace, projectId: oldId })}\n`,
    );
    await write(join(oldWorkspace, 'exports', 'report.md'), `workspace: ${oldWorkspace}\n`);
    await write(join(pilotHome, 'memory', 'trauma_med', oldId, 'memory', 'MEMORY.md'), `project ${oldId}\n`);
    const oldDatabase = join(pilotHome, 'memory', 'trauma_med', oldId, 'control.sqlite');
    const db = new DatabaseSync(oldDatabase);
    db.exec('CREATE TABLE pipeline_state (state_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO pipeline_state (state_key, state_json, updated_at) VALUES (?, ?, ?)')
      .run('workspaceDir', JSON.stringify(oldWorkspace), new Date().toISOString());
    db.close();
    await write(join(pilotHome, 'skill-availability.json'), '{"med-medical":["general_medicine"]}\n');
    await write(
      join(pilotHome, 'skills', 'trauma-only', 'SKILL.md'),
      '---\nname: trauma-only\navailability:\n  - war_trauma\n---\n# Trauma only\n',
    );

    const preview = await runTraumaMigration({ pilotHome, dryRun: true });
    assert.deepEqual(preview.projects.map(({ oldId: id, newId: next }) => [id, next]), [[oldId, newId]]);
    await access(join(pilotHome, 'projects', 'trauma_med', oldId));

    const result = await runTraumaMigration({ pilotHome });
    assert.equal(result.projects.length, 1);
    await assert.rejects(() => access(join(pilotHome, 'projects', 'trauma_med', oldId)));

    const meta = JSON.parse(await readFile(join(pilotHome, 'projects', 'general_med', newId, 'meta.json'), 'utf8'));
    assert.equal(meta.id, newId);
    assert.equal(meta.type, 'general_medicine');
    assert.equal(await readFile(join(pilotHome, 'projects', 'general_med', newId, '.cwd'), 'utf8'), newWorkspace);
    assert.match(
      await readFile(join(pilotHome, 'projects', 'general_med', newId, 'chats', 'session.jsonl'), 'utf8'),
      new RegExp(newId, 'u'),
    );
    assert.match(await readFile(join(newWorkspace, 'exports', 'report.md'), 'utf8'), /general_med\/general_med-example/u);
    assert.match(
      await readFile(join(pilotHome, 'memory', 'general_med', newId, 'memory', 'MEMORY.md'), 'utf8'),
      /general_med-example/u,
    );
    const migratedDb = new DatabaseSync(join(pilotHome, 'memory', 'general_med', newId, 'control.sqlite'));
    const workspaceState = migratedDb.prepare(
      'SELECT state_json FROM pipeline_state WHERE state_key = ?',
    ).get('workspaceDir');
    migratedDb.close();
    assert.equal(JSON.parse(workspaceState.state_json), newWorkspace);
    assert.deepEqual(
      JSON.parse(await readFile(join(pilotHome, 'skill-availability.json'), 'utf8')),
      { 'med-medical': ['global'] },
    );
    assert.match(
      await readFile(join(pilotHome, 'skills', 'trauma-only', 'SKILL.md'), 'utf8'),
      /availability:\n  - global/u,
    );

    const rerun = await runTraumaMigration({ pilotHome });
    assert.equal(rerun.projects.length, 0);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test('refuses to overwrite a colliding general project', async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), 'pilotdeck-trauma-migration-collision-'));
  try {
    await mkdir(join(pilotHome, 'projects', 'trauma_med', 'trauma_med-same'), { recursive: true });
    await mkdir(join(pilotHome, 'projects', 'general_med', 'general_med-same'), { recursive: true });
    await assert.rejects(
      () => runTraumaMigration({ pilotHome, dryRun: true }),
      /target already exists/u,
    );
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});
