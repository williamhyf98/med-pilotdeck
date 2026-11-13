/**
 * 回合结束时的 scratch 清理（2026-11-12，设计见 permission-arch-v2-design §8）。
 *
 * 只删「这一轮自己的中间产物」：
 *   - `scratch/work/<sessionId>/<turnId>/` —— 本轮的脚本、中间图、临时表；
 *   - `scratch/tool-results/<turnId>-*`    —— 本轮被截断后落盘的大工具输出
 *     （文件名前缀就是 turnId，见 `ToolResultBudget.scopedToolResultKey`）。
 *
 * **不碰** `scratch/qa`、`scratch/docx`、`scratch/data`、`scratch/tmp`、`scratch/preview`：
 * 这些是跨回合复用的草稿（例如上次生成文档时的 spec），删掉会让"再改一下"退化成整份重写。
 * 它们交给 `scratchRetention` 的 TTL 扫描。
 *
 * 硬约束：
 * - 只动 `scratch/` 下的目标，任何解析后跑出 `scratch/` 的路径一律跳过；
 * - 符号链接只删链接本身，不跟随；
 * - **永不抛错**：清理是旁路任务，删不掉只记日志，绝不影响主流程。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 与 `buildTurnEnvironment` 的 `safeWorkPathSegment` 保持一致，否则找不到目录。 */
export function safeScratchSegment(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  return normalized.replace(/^[-.]+|[-.]+$/g, '').slice(0, 96) || 'unknown';
}

async function pathSize(absolute) {
  let total = 0;
  let entries = [];
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = path.join(absolute, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await pathSize(child);
    else if (entry.isFile()) {
      const stat = await fs.lstat(child).catch(() => null);
      total += stat?.size ?? 0;
    }
  }
  return total;
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 删除本回合的 scratch 单元。
 *
 * @param {string} workspaceRoot 工作区根目录（绝对路径）
 * @param {{ sessionId?: string, turnId?: string, log?: Console }} options
 * @returns {Promise<{ removedDirs: string[], removedFiles: string[], freedBytes: number }>}
 */
export async function cleanTurnScratch(workspaceRoot, options = {}) {
  const result = { removedDirs: [], removedFiles: [], freedBytes: 0 };
  const log = options.log ?? console;
  const turnId = String(options.turnId ?? '').trim();
  if (!workspaceRoot || !turnId) return result;

  let scratchRoot;
  try {
    scratchRoot = path.resolve(workspaceRoot, 'scratch');
    const stat = await fs.lstat(scratchRoot).catch(() => null);
    if (!stat?.isDirectory()) return result;
  } catch {
    return result;
  }

  const safeTurn = safeScratchSegment(turnId);
  const safeSession = options.sessionId ? safeScratchSegment(options.sessionId) : '';

  // 优先删 <session>/<turn>；再兜底删 <turn>（没有 session 层的旧布局）。
  const candidates = [];
  if (safeSession) candidates.push(path.join(scratchRoot, 'work', safeSession, safeTurn));
  candidates.push(path.join(scratchRoot, 'work', safeTurn));

  for (const target of candidates) {
    if (!within(scratchRoot, target)) continue;
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat || stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;
    const bytes = await pathSize(target);
    try {
      await fs.rm(target, { recursive: true, force: true });
      result.removedDirs.push(path.relative(workspaceRoot, target).split(path.sep).join('/'));
      result.freedBytes += bytes;
    } catch (error) {
      log.warn?.('[scratch] turn cleanup failed:', error?.message ?? error);
    }
  }

  // 上一轮的空 session 目录顺手收掉（只在真的空了才删）。
  if (safeSession) {
    const sessionDir = path.join(scratchRoot, 'work', safeSession);
    if (within(scratchRoot, sessionDir)) {
      try {
        const left = await fs.readdir(sessionDir);
        if (left.length === 0) await fs.rmdir(sessionDir);
      } catch {
        /* 非空或不存在都忽略 */
      }
    }
  }

  // 本回合落盘的大工具输出：文件名形如 `<turnId>-<toolCallId>-...`。
  const toolResults = path.join(scratchRoot, 'tool-results');
  try {
    const entries = await fs.readdir(toolResults, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(`${safeTurn}-`)) continue;
      const absolute = path.join(toolResults, entry.name);
      if (!within(scratchRoot, absolute)) continue;
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat?.isFile()) continue;
      try {
        await fs.unlink(absolute);
        result.removedFiles.push(path.relative(workspaceRoot, absolute).split(path.sep).join('/'));
        result.freedBytes += stat.size;
      } catch (error) {
        log.warn?.('[scratch] tool-result cleanup failed:', error?.message ?? error);
      }
    }
  } catch {
    /* 没有 tool-results 目录是正常情况 */
  }

  return result;
}
