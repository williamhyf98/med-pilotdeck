/**
 * 管理员「技能依赖」只读页（docs/data-analysis-skill-design.zh.md §7）。
 *
 * 离线环境里"点一下安装"没有意义，所以这里只做三件事：列出依赖清单、
 * 报出运行时状态、报出 venv 里实际装到的版本。全部只读。
 *
 * 状态判定与 `skills/data-analysis/scripts/analysis.sh check` 必须一致，
 * 否则运维看到 ready、agent 却报 not ready：
 *
 *   stamp 不存在                        → not_bootstrapped
 *   stamp 内容 ≠ requirements 的 sha256 → missing_dependencies（清单改过，要重新 bootstrap）
 *   否则                                 → ready
 *
 * 这里刻意不 spawn python：每次刷新都起进程太贵，而且管理页不该有执行面。
 * venv 里装了什么，直接读 `lib/python3.x/site-packages/*.dist-info` 的目录名。
 */
import express from 'express';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const router = express.Router();

const SKILL_ROOT = path.resolve(
  process.env.PILOTDECK_DATA_ANALYSIS_SKILL_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'data-analysis'),
);

const TIER_NAMES = {
  基础档: 'base',
  统计档: 'stats',
  医学档: 'medical',
};

const TIER_HEADING = /^#\s*-+\s*(.+?)\s*-+\s*$/;
const REQUIREMENT_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/;

export function analysisCacheRoot(env = process.env) {
  if (env.PILOTDECK_ANALYSIS_CACHE) return path.resolve(env.PILOTDECK_ANALYSIS_CACHE);
  const base = env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache');
  return path.join(base, 'pilotdeck-analysis');
}

/** 解析 requirements.txt：包名 / 版本约束 / 档位。注释与空行忽略。 */
export function parseRequirements(text) {
  const entries = [];
  let tier = 'other';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const heading = line.match(TIER_HEADING);
      if (heading) tier = TIER_NAMES[heading[1]] || 'other';
      continue;
    }
    const match = line.match(REQUIREMENT_LINE);
    if (!match) continue;
    entries.push({
      name: match[1],
      extras: (match[2] || '').replace(/^\[|\]$/g, ''),
      specifier: (match[3] || '').trim(),
      tier,
    });
  }
  return entries;
}

function normalizeName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

/** 读 venv 里真正装上的版本：`<name>-<version>.dist-info` 目录名就是事实来源。 */
export async function readInstalledVersions(runtimeDir) {
  const installed = new Map();
  let libDir = null;
  try {
    const entries = await fs.readdir(path.join(runtimeDir, 'lib'), { withFileTypes: true });
    const pythonDir = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('python'));
    if (!pythonDir) return installed;
    libDir = path.join(runtimeDir, 'lib', pythonDir.name, 'site-packages');
  } catch {
    return installed;
  }
  let distInfos = [];
  try {
    distInfos = await fs.readdir(libDir, { withFileTypes: true });
  } catch {
    return installed;
  }
  for (const entry of distInfos) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue;
    const stem = entry.name.slice(0, -'.dist-info'.length);
    const at = stem.lastIndexOf('-');
    if (at <= 0) continue;
    installed.set(normalizeName(stem.slice(0, at)), stem.slice(at + 1));
  }
  return installed;
}

async function readStamp(runtimeDir) {
  const stampPath = path.join(runtimeDir, '.pilotdeck-requirements-hash');
  try {
    const [hash, stats] = await Promise.all([fs.readFile(stampPath, 'utf8'), fs.stat(stampPath)]);
    return { hash: hash.trim(), bootstrappedAt: stats.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 组装管理页需要的全部字段。skillRoot / cacheRoot 可注入，便于测试。 */
export async function describeDataAnalysisDeps({
  skillRoot = SKILL_ROOT,
  cacheRoot = analysisCacheRoot(),
  env = process.env,
} = {}) {
  const requirementsPath = path.join(skillRoot, 'runtime', 'requirements.txt');
  const raw = await fs.readFile(requirementsPath);
  const entries = parseRequirements(raw.toString('utf8'));
  const requirementsHash = createHash('sha256').update(raw).digest('hex');

  const runtimeDir = path.join(cacheRoot, 'runtime');
  const venvPython = path.join(runtimeDir, 'bin', 'python');
  const stamp = await readStamp(runtimeDir);
  const installed = await readInstalledVersions(runtimeDir);

  let status = 'not_bootstrapped';
  if (await exists(venvPython)) {
    status = stamp && stamp.hash === requirementsHash ? 'ready' : 'missing_dependencies';
  }

  const packages = entries.map((entry) => ({
    ...entry,
    installed: installed.get(normalizeName(entry.name)) || null,
  }));
  const byTier = {};
  for (const entry of entries) byTier[entry.tier] = (byTier[entry.tier] || 0) + 1;

  return {
    skill: 'data-analysis',
    readOnly: true,
    runtime: {
      status,
      usable: status === 'ready',
      path: runtimeDir,
      requirementsHash,
      bootstrappedAt: stamp ? stamp.bootstrappedAt : null,
      stampMatches: stamp ? stamp.hash === requirementsHash : null,
    },
    environment: {
      cacheRoot,
      skillRoot,
      pythonOverride: env.PILOTDECK_ANALYSIS_PYTHON || null,
    },
    counts: {
      total: entries.length,
      installed: packages.filter((entry) => entry.installed).length,
      byTier,
    },
    packages,
  };
}

router.get('/data-analysis/deps', async (_req, res) => {
  try {
    res.json(await describeDataAnalysisDeps());
  } catch (error) {
    res.status(500).json({
      error: 'deps_unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
