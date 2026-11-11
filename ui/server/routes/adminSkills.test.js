// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analysisCacheRoot,
  describeDataAnalysisDeps,
  parseRequirements,
  readInstalledVersions,
} from './adminSkills.js';

const cleanup = [];

async function makeTemp(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const REQUIREMENTS = [
  '# 说明注释',
  '# ---- 基础档 ----',
  'pandas>=2.2,<3',
  'Pillow>=10.0.0',
  '#',
  '# ---- 统计档 ----',
  'scikit-learn>=1.4,<1.6',
  '# ---- 医学档 ----',
  'pydicom>=2.4.0',
  '',
].join('\n');

/** 造一个"已 bootstrap"的假运行时：venv python + 哈希戳 + 若干 dist-info。 */
async function makeRuntime(root, { requirements, stampHash, versions = {} }) {
  const skillRoot = path.join(root, 'skills', 'data-analysis');
  await fs.mkdir(path.join(skillRoot, 'runtime'), { recursive: true });
  const requirementsPath = path.join(skillRoot, 'runtime', 'requirements.txt');
  await fs.writeFile(requirementsPath, requirements);

  const runtimeDir = path.join(root, 'cache', 'runtime');
  await fs.mkdir(path.join(runtimeDir, 'bin'), { recursive: true });
  await fs.writeFile(path.join(runtimeDir, 'bin', 'python'), '');
  if (stampHash !== null) {
    const hash = stampHash === 'current'
      ? createHash('sha256').update(await fs.readFile(requirementsPath)).digest('hex')
      : stampHash;
    await fs.writeFile(path.join(runtimeDir, '.pilotdeck-requirements-hash'), `${hash}\n`);
  }

  const sitePackages = path.join(runtimeDir, 'lib', 'python3.12', 'site-packages');
  await fs.mkdir(sitePackages, { recursive: true });
  for (const [name, version] of Object.entries(versions)) {
    await fs.mkdir(path.join(sitePackages, `${name}-${version}.dist-info`), { recursive: true });
  }

  return { skillRoot, cacheRoot: path.join(root, 'cache') };
}

describe('parseRequirements', () => {
  it('按档位分组，保留版本约束，忽略注释与空行', () => {
    const entries = parseRequirements(REQUIREMENTS);
    expect(entries).toEqual([
      { name: 'pandas', extras: '', specifier: '>=2.2,<3', tier: 'base' },
      { name: 'Pillow', extras: '', specifier: '>=10.0.0', tier: 'base' },
      { name: 'scikit-learn', extras: '', specifier: '>=1.4,<1.6', tier: 'stats' },
      { name: 'pydicom', extras: '', specifier: '>=2.4.0', tier: 'medical' },
    ]);
  });

  it('识别 extras 写法', () => {
    expect(parseRequirements('uvicorn[standard]>=0.30')).toEqual([
      { name: 'uvicorn', extras: 'standard', specifier: '>=0.30', tier: 'other' },
    ]);
  });
});

describe('analysisCacheRoot', () => {
  it('优先用 PILOTDECK_ANALYSIS_CACHE，其次 XDG_CACHE_HOME，最后 ~/.cache', () => {
    expect(analysisCacheRoot({ PILOTDECK_ANALYSIS_CACHE: '/x/cache' })).toBe('/x/cache');
    const noApp = { appRoot: '/nonexistent-app-root' };
    expect(analysisCacheRoot({ XDG_CACHE_HOME: '/xdg' }, noApp)).toBe(path.join('/xdg', 'pilotdeck-analysis'));
    expect(analysisCacheRoot({ HOME: '/home/u' }, noApp)).toBe(path.join('/home/u', '.cache', 'pilotdeck-analysis'));
  });

  it('存在共享只读运行时时优先用它（与 analysis.sh 的探测顺序一致）', async () => {
    const appRoot = await makeTemp('pd-app-root-');
    const shared = path.join(appRoot, '.runtime', 'cache', 'xdg', 'pilotdeck-analysis');
    await fs.mkdir(path.join(shared, 'runtime', 'bin'), { recursive: true });
    await fs.writeFile(path.join(shared, 'runtime', 'bin', 'python'), '', 'utf8');
    expect(analysisCacheRoot({ XDG_CACHE_HOME: '/xdg' }, { appRoot })).toBe(shared);
  });
});

describe('readInstalledVersions', () => {
  it('从 dist-info 目录名读出包名与版本，名字按 PEP 503 归一化', async () => {
    const root = await makeTemp('pd-deps-installed-');
    const { cacheRoot } = await makeRuntime(root, {
      requirements: REQUIREMENTS,
      stampHash: 'current',
      versions: { pandas: '2.2.3', 'scikit_learn': '1.5.2', PyYAML: '6.0.2' },
    });
    const installed = await readInstalledVersions(path.join(cacheRoot, 'runtime'));
    expect(installed.get('pandas')).toBe('2.2.3');
    expect(installed.get('scikit-learn')).toBe('1.5.2');
    expect(installed.get('pyyaml')).toBe('6.0.2');
  });

  it('运行时不存在时返回空表而不是抛错', async () => {
    const root = await makeTemp('pd-deps-missing-');
    const installed = await readInstalledVersions(path.join(root, 'nope'));
    expect(installed.size).toBe(0);
  });
});

describe('describeDataAnalysisDeps', () => {
  it('没有 venv → not_bootstrapped，且不谎报已安装', async () => {
    const root = await makeTemp('pd-deps-fresh-');
    const skillRoot = path.join(root, 'skills', 'data-analysis');
    await fs.mkdir(path.join(skillRoot, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(skillRoot, 'runtime', 'requirements.txt'), REQUIREMENTS);

    const result = await describeDataAnalysisDeps({
      skillRoot,
      cacheRoot: path.join(root, 'cache'),
      env: {},
    });
    expect(result.runtime.status).toBe('not_bootstrapped');
    expect(result.runtime.usable).toBe(false);
    expect(result.runtime.bootstrappedAt).toBeNull();
    expect(result.counts).toEqual({ total: 4, installed: 0, byTier: { base: 2, stats: 1, medical: 1 } });
    expect(result.packages.every((entry) => entry.installed === null)).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('venv 存在且哈希戳匹配 → ready，并带上实际安装版本与 bootstrap 时间', async () => {
    const root = await makeTemp('pd-deps-ready-');
    const { skillRoot, cacheRoot } = await makeRuntime(root, {
      requirements: REQUIREMENTS,
      stampHash: 'current',
      versions: { pandas: '2.2.3', Pillow: '11.0.0', pydicom: '2.4.4' },
    });

    const result = await describeDataAnalysisDeps({ skillRoot, cacheRoot, env: {} });
    expect(result.runtime.status).toBe('ready');
    expect(result.runtime.usable).toBe(true);
    expect(result.runtime.stampMatches).toBe(true);
    expect(Number.isNaN(Date.parse(result.runtime.bootstrappedAt))).toBe(false);
    expect(result.counts.installed).toBe(3);
    expect(result.packages.find((entry) => entry.name === 'pandas').installed).toBe('2.2.3');
    expect(result.packages.find((entry) => entry.name === 'scikit-learn').installed).toBeNull();
  });

  it('依赖清单改过（哈希对不上）→ missing_dependencies', async () => {
    const root = await makeTemp('pd-deps-stale-');
    const { skillRoot, cacheRoot } = await makeRuntime(root, {
      requirements: REQUIREMENTS,
      stampHash: 'deadbeef',
      versions: { pandas: '2.2.3' },
    });

    const result = await describeDataAnalysisDeps({ skillRoot, cacheRoot, env: {} });
    expect(result.runtime.status).toBe('missing_dependencies');
    expect(result.runtime.usable).toBe(false);
    expect(result.runtime.stampMatches).toBe(false);
  });

  it('requirements.txt 缺失 → 抛错（路由层转 500，而不是假装一切正常）', async () => {
    const root = await makeTemp('pd-deps-nofile-');
    await expect(
      describeDataAnalysisDeps({ skillRoot: path.join(root, 'nope'), cacheRoot: root, env: {} }),
    ).rejects.toThrow();
  });
});
