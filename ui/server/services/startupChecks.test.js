import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-startup-')); vi.resetModules(); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.PILOTDECK_DEPLOY_ENV; });

describe('checkMedicalPlugin', () => {
  it('is silent when <root>/plugins/med-tools/plugin.json exists', async () => {
    const { checkMedicalPlugin } = await import('./startupChecks.js');
    fs.mkdirSync(path.join(tmp, 'root/plugins/med-tools'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'root/plugins/med-tools/plugin.json'), '{}');
    const log = vi.fn();
    expect(checkMedicalPlugin({ root: path.join(tmp, 'root'), repoRoot: path.join(tmp, 'repo'), log })).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('names the link command when the repository has the plugin but the root does not', async () => {
    const { checkMedicalPlugin } = await import('./startupChecks.js');
    fs.mkdirSync(path.join(tmp, 'root/plugins'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'repo/plugins/med-tools'), { recursive: true });
    const log = vi.fn();
    const message = checkMedicalPlugin({ root: path.join(tmp, 'root'), repoRoot: path.join(tmp, 'repo'), log });
    expect(message).toContain('ln -sfn');
    expect(message).toContain(path.join(tmp, 'repo/plugins/med-tools'));
    expect(message).toContain('unavailable to every user');
    expect(log).toHaveBeenCalledWith(message);
  });

  it('says so when the plugin exists nowhere', async () => {
    const { checkMedicalPlugin } = await import('./startupChecks.js');
    const message = checkMedicalPlugin({ root: path.join(tmp, 'root'), repoRoot: path.join(tmp, 'repo'), log: () => {} });
    expect(message).toContain('none in the repository');
  });
});

describe('checkDeployEnv', () => {
  it('warns when the deploy env file is missing', async () => {
    process.env.PILOTDECK_DEPLOY_ENV = path.join(tmp, 'absent.env');
    const { checkDeployEnv } = await import('./startupChecks.js');
    const log = vi.fn();
    const message = checkDeployEnv({ log });
    expect(message).toContain('absent.env');
    expect(message).toContain('127.0.0.1');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('is silent when the file exists', async () => {
    const file = path.join(tmp, 'deploy.env');
    fs.writeFileSync(file, '# empty site file\n');
    process.env.PILOTDECK_DEPLOY_ENV = file;
    const { checkDeployEnv } = await import('./startupChecks.js');
    const log = vi.fn();
    expect(checkDeployEnv({ log })).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});
