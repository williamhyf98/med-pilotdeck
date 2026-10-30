import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = join(root, 'scripts', 'pre-flight-check.sh');

function fixture(t, { platform = 'Linux', auth, deployAuth, bwrap = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-preflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\nprintf '%s\\n' '${platform}'\n`, { mode: 0o755 });
  for (const name of ['bash', 'sh', 'dirname', 'mkdir', 'readlink', 'sed', 'npm']) {
    symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), join(bin, name));
  }
  writeFileSync(join(bin, 'node'), `#!/bin/sh
case " $* " in
  *" server/index.js "*|*" bootstrap-pilotdeck-config.mjs "*) echo "blocked test server/bootstrap launch" >&2; exit 99 ;;
esac
exec "${process.execPath}" "$@"
`, { mode: 0o755 });
  if (bwrap) writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const deployFile = join(dir, 'deploy.env');
  if (deployAuth !== undefined) {
    writeFileSync(deployFile, `# Site configuration\nexport PILOTDECK_DISABLE_LOCAL_AUTH="${deployAuth}"\n`);
  }
  const home = join(dir, 'home');
  const env = {
    ...process.env,
    PATH: bin,
    PILOTDECK_DEPLOY_ENV: deployFile,
    PILOT_HOME: home,
    PILOTDECK_CONFIG_DIR: home,
    PILOTDECK_CONFIG_PATH: join(home, 'pilotdeck.yaml'),
  };
  if (auth === undefined) delete env.PILOTDECK_DISABLE_LOCAL_AUTH;
  else env.PILOTDECK_DISABLE_LOCAL_AUTH = auth;
  return { dir, bin, env };
}

function runCheck(env) {
  return spawnSync('/bin/bash', [check], { env, encoding: 'utf8', cwd: '/' });
}

test('Linux login mode refuses startup without bwrap and explains installation', (t) => {
  const { env } = fixture(t, { auth: '0' });
  const result = runCheck(env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires bubblewrap.*bwrap.*not found/s);
  assert.match(result.stderr, /sudo apt install bubblewrap/);
});

test('Linux login mode accepts bwrap on PATH, including auth=false', (t) => {
  const { env, bin } = fixture(t, { auth: 'false', bwrap: true });
  const result = runCheck(env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`bubblewrap found: ${bin}/bwrap`));
});

test('reads login mode from deploy.env when shell variable is unset', (t) => {
  const { env } = fixture(t, { deployAuth: '0' });
  const result = runCheck(env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires bubblewrap/);
});

test('shell auth setting takes precedence over deploy.env', (t) => {
  const { env } = fixture(t, { auth: '1', deployAuth: '0' });
  const result = runCheck(env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No-login mode/);
});

test('macOS login mode reports development-only sandbox-exec', (t) => {
  const { env } = fixture(t, { platform: 'Darwin', auth: '0' });
  const result = runCheck(env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sandbox-exec.*development only/);
});

test('no-login mode does not require bwrap', (t) => {
  const { env } = fixture(t);
  const result = runCheck(env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No-login mode/);
});

test('start-local checks before bootstrapping or starting a server', (t) => {
  const { dir, env } = fixture(t, { auth: '0' });
  const scripts = join(dir, 'scripts');
  mkdirSync(scripts);
  for (const name of ['lib-local-runtime.sh', 'start-local.sh', 'pre-flight-check.sh']) {
    if (existsSync(join(root, 'scripts', name))) copyFileSync(join(root, 'scripts', name), join(scripts, name));
  }
  writeFileSync(join(scripts, 'config.env'), 'SERVER_PORT=39133\nPILOTDECK_GATEWAY_PORT=39134\nVITE_PORT=39135\n');
  const result = spawnSync('/bin/bash', [join(scripts, 'start-local.sh'), '--fg'], { env, encoding: 'utf8', cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires bubblewrap/);
  assert.doesNotMatch(result.stderr, /Cannot find module/);
});

test('start-offline checks before preparing Python or starting services', (t) => {
  const { dir, env } = fixture(t, { deployAuth: '0' });
  const scripts = join(dir, 'scripts');
  mkdirSync(scripts);
  for (const name of ['offline-runtime.sh', 'start-offline.sh', 'pre-flight-check.sh']) {
    copyFileSync(join(root, 'scripts', name), join(scripts, name));
  }
  mkdirSync(env.PILOT_HOME);
  writeFileSync(join(env.PILOT_HOME, 'pilotdeck.yaml'), 'schemaVersion: 1\n');
  const result = spawnSync('/bin/bash', [join(scripts, 'start-offline.sh')], {
    env, encoding: 'utf8', cwd: dir,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires bubblewrap/);
  assert.equal(existsSync(join(dir, '.runtime', 'offline', 'gateway.pid')), false);
});

test('both npm UI server entrypoints check before starting the service', (t) => {
  const { env } = fixture(t, { deployAuth: 'false' });
  for (const entry of ['dev:server', 'server']) {
    const result = spawnSync(join(env.PATH, 'npm'), ['--prefix', join(root, 'ui'), 'run', entry], {
      env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 1, `${entry}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /requires bubblewrap/, entry);
    assert.doesNotMatch(result.stderr, /blocked test server\/bootstrap launch/);
  }
});
