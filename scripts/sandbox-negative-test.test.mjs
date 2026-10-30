import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'sandbox-negative-test.sh');

function fixture(t, bwrap) {
  const base = mkdtempSync('/tmp/pd-negative-script-test-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin');
  mkdirSync(bin);
  if (bwrap) writeFileSync(join(bin, 'bwrap'), bwrap, { mode: 0o755 });
  return { base, bin, root: join(base, 'isolated') };
}

function run({ bin, root }) {
  return spawnSync('/bin/bash', [script, '--platform', 'linux', '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

test('does not delete or replace an existing --root', (t) => {
  const f = fixture(t);
  mkdirSync(f.root);
  const marker = join(f.root, 'keep.txt');
  writeFileSync(marker, 'user-data');
  const result = run(f);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(readFileSync(marker, 'utf8'), 'user-data');
});

test('recognizes a sandbox denial even when bwrap exits nonzero', (t) => {
  const f = fixture(t, `#!/bin/sh
case "$*" in
  *accessible.txt*) printf '%s\\n' 'owned-data'; exit 0 ;;
  *) printf '%s\\n' 'No such file or directory' >&2; exit 1 ;;
esac
`);
  const result = run(f);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /NEGATIVE TESTS PASS/);
  assert.equal(existsSync(f.root), false);
});

test('rejects a successful command even if it prints a denial message', (t) => {
  const f = fixture(t, `#!/bin/sh
case "$*" in
  *accessible.txt*) printf '%s\\n' 'owned-data' ;;
  *) printf '%s\\n' 'No such file or directory' ;;
esac
exit 0
`);
  const result = run(f);
  assert.notEqual(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /NEGATIVE TESTS PASS/);
});
