import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, symlinkSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('portable migration backs up managed paths, survives a move and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-migration-'));
  try {
    const repo = join(root, 'repo');
    const home = join(repo, '.pilotdeck-home');
    const project = join(home, 'projects/trauma_med/trauma_med-demo');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(home, 'workspaces/trauma_med/trauma_med-demo'), { recursive: true });
    mkdirSync(join(home, 'plugins'), { recursive: true });
    mkdirSync(join(repo, 'plugins/med-tools'), { recursive: true });
    writeFileSync(join(project, '.cwd'), '/Users/old/app/.pilotdeck-home/workspaces/trauma_med/trauma_med-demo');
    writeFileSync(join(home, 'pilotdeck.yaml'), 'webui:\n  runtime:\n    databasePath: /Users/old/app/.pilotdeck-home/auth.db\n    workspacesRoot: /Users/old\n');
    symlinkSync('/Users/old/app/plugins/med-tools', join(home, 'plugins/med-tools'));
    const run = (...args) => JSON.parse(execFileSync(process.execPath, ['scripts/migrate-portable-paths.mjs', '--pilot-home', home, '--repo-root', repo, ...args], { encoding: 'utf8' }));
    assert.equal(run('--dry-run').changes.length, 3);
    assert.ok(readFileSync(join(project, '.cwd'), 'utf8').startsWith('/Users/'));
    const report = run();
    assert.equal(report.changes.length, 3);
    assert.ok(existsSync(report.backupDir));
    assert.equal(readFileSync(join(project, '.cwd'), 'utf8'), 'workspaces/trauma_med/trauma_med-demo');
    assert.equal(readlinkSync(join(home, 'plugins/med-tools')), '../../plugins/med-tools');
    assert.match(readFileSync(join(home, 'pilotdeck.yaml'), 'utf8'), /databasePath: auth.db/);
    assert.equal(run().changes.length, 0);
    const moved = join(root, 'moved');
    renameSync(repo, moved);
    assert.ok(existsSync(join(moved, '.pilotdeck-home/plugins/med-tools')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
