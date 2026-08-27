// @ts-nocheck
/**
 * P0.1: migrate-typed-projects.mjs nests sys-* and legacy general.
 * Run: node --test tests/pilot/migrate-typed-projects.spec.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('migrate-typed-projects renames sys-* and nests under typeKey', async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), 'pilotdeck-migrate-typed-'));
  const script = join(process.cwd(), 'scripts/migrate-typed-projects.mjs');

  const sysId = 'sys-abc123-dead01';
  const traumaId = 'sys-trauma1-beef02';
  await mkdir(join(pilotHome, 'projects', sysId, 'chats'), { recursive: true });
  await mkdir(join(pilotHome, 'workspaces', sysId, 'inbox'), { recursive: true });
  await writeFile(
    join(pilotHome, 'projects', sysId, 'meta.json'),
    JSON.stringify({
      id: sysId,
      displayName: '旧通用',
      type: 'general_medicine',
      kind: 'system',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  await writeFile(
    join(pilotHome, 'projects', sysId, '.cwd'),
    join(pilotHome, 'workspaces', sysId),
  );

  await mkdir(join(pilotHome, 'projects', traumaId, 'chats'), { recursive: true });
  await mkdir(join(pilotHome, 'workspaces', traumaId, 'inbox'), { recursive: true });
  await writeFile(
    join(pilotHome, 'projects', traumaId, 'meta.json'),
    JSON.stringify({
      id: traumaId,
      displayName: '旧战创伤',
      type: 'war_trauma',
      kind: 'system',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  await writeFile(
    join(pilotHome, 'projects', traumaId, '.cwd'),
    join(pilotHome, 'workspaces', traumaId),
  );

  await mkdir(join(pilotHome, 'workspaces', 'general', 'inbox'), { recursive: true });
  await writeFile(join(pilotHome, 'workspaces', 'general', 'inbox', 'note.txt'), 'hi');

  const homeSlug = pilotHome.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  await mkdir(join(pilotHome, 'projects', homeSlug, 'chats'), { recursive: true });
  await writeFile(
    join(pilotHome, 'projects', homeSlug, 'chats', 'web:s_legacy.jsonl'),
    '{"type":"session"}\n',
  );

  await mkdir(join(pilotHome, 'memory', 'global'), { recursive: true });
  await writeFile(join(pilotHome, 'memory', 'global', 'profile.txt'), 'user');

  const result = spawnSync(process.execPath, [script, '--pilot-home', pilotHome], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const generalNew = 'general_med-abc123-dead01';
  const traumaNew = 'trauma_med-trauma1-beef02';

  await access(join(pilotHome, 'projects', 'general_med', generalNew, 'meta.json'));
  await access(join(pilotHome, 'workspaces', 'general_med', generalNew, 'inbox'));
  const generalMeta = JSON.parse(
    await readFile(join(pilotHome, 'projects', 'general_med', generalNew, 'meta.json'), 'utf8'),
  );
  assert.equal(generalMeta.id, generalNew);
  assert.equal(generalMeta.migratedFrom, sysId);

  await access(join(pilotHome, 'projects', 'trauma_med', traumaNew, 'meta.json'));
  await access(join(pilotHome, 'workspaces', 'trauma_med', traumaNew, 'inbox'));

  await access(join(pilotHome, 'projects', 'general_med', 'general_med-legacy-general', 'meta.json'));
  await access(join(
    pilotHome,
    'projects',
    'general_med',
    'general_med-legacy-general',
    'chats',
    'web:s_legacy.jsonl',
  ));
  await access(join(
    pilotHome,
    'workspaces',
    'general_med',
    'general_med-legacy-general',
    'inbox',
    'note.txt',
  ));
  await access(join(pilotHome, 'memory', 'global', 'profile.txt'));

  // Idempotent second run
  const second = spawnSync(process.execPath, [script, '--pilot-home', pilotHome], {
    encoding: 'utf8',
  });
  assert.equal(second.status, 0, second.stderr || second.stdout);

  await rm(pilotHome, { recursive: true, force: true });
});
