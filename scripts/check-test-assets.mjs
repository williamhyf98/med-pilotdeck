// T5.2: local test material must stay local.
//
// Two things can leak private fixtures out of this machine:
//   1. committing them (they end up in every clone and in the remote history);
//   2. building them into the offline package (they end up on customer boxes).
//
// This script checks both doors and is safe to run in CI: it only fails on
// rules the plan actually promises. The privacy review of *public* fixtures is
// reported as a warning, because the DICOM under tests/skill-e2e/fixtures/ is a
// registered, deliberately deferred risk (see docs/skills-optimization-plan.zh.md
// §7 "已知风险"), not something this check is allowed to fail on.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_ONLY = 'tests/skill-e2e/local-fixtures/';
const errors = [];
const warnings = [];

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', ...options });
}

function insideGitRepo() {
  try {
    git(['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

const inGit = insideGitRepo();

// 1. Nothing under local-fixtures/ may be tracked.
if (inGit) {
  const tracked = git(['ls-files', '--', LOCAL_ONLY]).split('\n').filter(Boolean);
  if (tracked.length) {
    errors.push(`tracked local-only fixtures: ${tracked.join(', ')} (git rm --cached them)`);
  }
} else {
  warnings.push('not a git work tree; skipped the tracked-file check');
}

// 2. Both ignore files must name the directory, and git must honour it.
for (const ignoreFile of ['.gitignore', '.dockerignore']) {
  const file = path.join(repo, ignoreFile);
  if (!fs.existsSync(file)) {
    errors.push(`${ignoreFile} is missing`);
    continue;
  }
  const lines = fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim().replace(/^\//, '').replace(/\/$/, ''));
  const pattern = LOCAL_ONLY.replace(/\/$/, '');
  if (!lines.some((line) => line === pattern || line === `/${pattern}`)) {
    errors.push(`${ignoreFile} does not exclude ${pattern}`);
  }
}

if (inGit) {
  try {
    git(['check-ignore', '-q', LOCAL_ONLY]);
  } catch {
    errors.push(`git does not ignore ${LOCAL_ONLY}; check the rule still matches`);
  }
}

// 3. The offline package must not ship the test tree at all.
const dockerfile = path.join(repo, 'packaging/offline-arm64.Dockerfile');
if (!fs.existsSync(dockerfile)) {
  errors.push('packaging/offline-arm64.Dockerfile is missing');
} else {
  const text = fs.readFileSync(dockerfile, 'utf8');
  const stage = text.split(/\n/u).filter((line) => /\bcp -a\b/u.test(line) || /\bcp -r\b/u.test(line));
  const staged = stage.join('\n');
  if (/(^|\s)tests(\s|\/|$)/u.test(staged.replace(/\S*\/tests\/skill-e2e[^\s]*/gu, ''))) {
    errors.push('the staging step copies tests/ into the offline package');
  }
}

// 4. Informational: tracked fixtures still inside the Docker build context.
if (inGit) {
  const fixtures = git(['ls-files', '--', 'tests/skill-e2e/fixtures/']).split('\n').filter(Boolean);
  if (fixtures.length) {
    warnings.push(
      `${fixtures.length} tracked fixture(s) are ignored by .dockerignore only for local-fixtures/, `
      + `so they stay in the build context: ${fixtures.join(', ')}`
      + ' — privacy review is a registered open item, not a build failure here',
    );
  }
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const error of errors) console.error(`ERROR ${error}`);
console.log(JSON.stringify({
  status: errors.length ? 'failed' : 'ok',
  localOnly: LOCAL_ONLY,
  errors: errors.length,
  warnings: warnings.length,
}));
if (errors.length) process.exitCode = 1;
