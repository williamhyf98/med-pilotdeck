// @ts-nocheck
/**
 * P7: archiveAndDeleteProjectStorage archives $WS and removes chats + project memory.
 * Run: node --test tests/pilot/delete-project.spec.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

async function assertMissing(targetPath) {
  await assert.rejects(() => access(targetPath), { code: 'ENOENT' });
}

test('archiveAndDeleteProjectStorage archives workspace and removes chats + memory', async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), 'pilotdeck-del-proj-'));
  try {
    const deleteMod = await import(
      pathToFileURL(join(process.cwd(), 'ui/server/utils/projectDelete.js')).href
    );
    const pathsMod = await import(
      pathToFileURL(join(process.cwd(), 'ui/server/utils/pilotPaths.js')).href
    );

    const projectId = 'general_med-p7demo01';
    const typeKey = 'general_med';
    const projectDir = join(pilotHome, 'projects', typeKey, projectId);
    const workspaceDir = join(pilotHome, 'workspaces', typeKey, projectId);
    const memoryDir = join(pilotHome, 'memory', typeKey, projectId);

    await mkdir(join(projectDir, 'chats'), { recursive: true });
    await writeFile(join(projectDir, 'chats', 'sess-p7.jsonl'), '{"type":"user"}\n', 'utf8');
    await writeFile(
      join(projectDir, 'meta.json'),
      JSON.stringify({ id: projectId, type: 'general_medicine', kind: 'system' }),
      'utf8',
    );
    await mkdir(join(workspaceDir, 'exports'), { recursive: true });
    await mkdir(join(workspaceDir, 'inbox', 'batch-1'), { recursive: true });
    await writeFile(join(workspaceDir, 'exports', 'note.txt'), 'keep-me', 'utf8');
    await writeFile(join(workspaceDir, 'inbox', 'batch-1', 'photo.jpg'), 'img', 'utf8');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, 'notes.md'), 'project memory', 'utf8');

    assert.equal(
      pathsMod.resolveTypedProjectDir(projectId, pilotHome),
      projectDir,
    );
    assert.equal(
      pathsMod.resolveWorkspaceDataRoot(projectId, pilotHome),
      workspaceDir,
    );

    const result = await deleteMod.archiveAndDeleteProjectStorage({
      pilotHome,
      projectId,
      force: true,
    });
    assert.equal(result.success, true);
    assert.equal(result.projectId, projectId);
    assert.ok(result.archivePath);
    assert.match(result.archivePath, /archives[/\\]projects[/\\]/);

    await assertMissing(projectDir);
    await assertMissing(memoryDir);
    await assertMissing(workspaceDir);

    assert.equal(await readFile(join(result.archivePath, 'exports', 'note.txt'), 'utf8'), 'keep-me');
    assert.equal(
      await readFile(join(result.archivePath, 'inbox', 'batch-1', 'photo.jpg'), 'utf8'),
      'img',
    );

    const entries = await readdir(join(pilotHome, 'archives', 'projects'));
    assert.ok(entries.some((name) => name.startsWith(`${projectId}-`)));
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test('resolveProjectArchiveDir nests under archives/projects', async () => {
  const {
    resolveProjectArchiveDir,
    formatProjectArchiveTimestamp,
  } = await import(pathToFileURL(join(process.cwd(), 'ui/server/utils/pilotPaths.js')).href);

  const pilotHome = '/tmp/pilot-home-example';
  const stamp = formatProjectArchiveTimestamp(new Date('2026-08-27T12:25:30.000Z'));
  assert.equal(stamp, '20260827T122530Z');
  assert.equal(
    resolveProjectArchiveDir('general_med-abc', stamp, pilotHome),
    join(pilotHome, 'archives', 'projects', `general_med-abc-${stamp}`),
  );
});
