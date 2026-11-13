/**
 * 工作区配额/清理参数（设计书 §8.2、§9.5）。
 *
 * 唯一来源：`<PILOT_HOME>/pilotdeck.yaml` 的 `workspace.quota`。缺配置时全部走默认值，
 * 所以没有配额段的机器也能正常启动（§9.5 "代码默认值保持可运行"）。
 *
 * 这些数字**只用于提示与清理**，任何一条都不会拒绝写入：
 * - `workspaceWarnBytes` / `scratchMaxBytes` → 页面用量条变色；
 * - `scratchTtlDays` / `protectRecentMinutes` → scratch 自动清理（只清 scratch）。
 *
 * 读取结果缓存 60 s，`?refresh=1` 之类的手动刷新会调 `invalidateWorkspaceLimitsCache()`。
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolvePilotRoot } from '../utils/pilotPaths.js';

const CACHE_TTL_MS = 60_000;
const GiB = 1024 ** 3;

export const DEFAULT_WORKSPACE_LIMITS = Object.freeze({
  /** 工作区总量提示线（只提示，永不拒绝写入）。 */
  workspaceWarnBytes: 5 * GiB,
  /** scratch 上限；到达后由系统按 §8.4 清理。 */
  scratchMaxBytes: 1 * GiB,
  /** 超过上限的多少比例开始变黄。 */
  scratchSoftRatio: 0.8,
  /** scratch 兜底 TTL：多久没访问就清（回合目录已在回合结束时删，这里管剩下的草稿）。 */
  scratchTtlDays: 7,
  /** 保护窗：这段时间内动过的单元不清理。 */
  protectRecentMinutes: 10,
  /** 回合结束时是否立即删本轮的 scratch 单元（work/<session>/<turn> + 本轮的 tool-results）。 */
  cleanOnTurnEnd: true,
  /**
   * 会话级工具结果缓存（`<workspace>/.pilotdeck/tool-results/`）的兜底 TTL。
   * 会话删除时会立即清；这里是"用户从不删会话"时的保险。
   */
  toolResultsTtlDays: 14,
  /** 覆盖快照保留（与回收站一致，7 天）。 */
  snapshotRetentionDays: 7,
  /** 单用户总量告警值。 */
  userTotalMaxBytes: 20 * GiB,
  /** 影像类工作区覆盖值。 */
  imagingScratchMaxBytes: 2 * GiB,
});

/** { limits, expiresAt } */
let cache = null;

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ratio(value, fallback) {
  return Number.isFinite(value) && value >= 0.5 && value <= 0.95 ? value : fallback;
}

function normalizeQuota(quota) {
  const base = DEFAULT_WORKSPACE_LIMITS;
  const overrides = quota?.overrides?.imaging ?? {};
  return {
    workspaceWarnBytes: positiveNumber(quota?.workspaceWarnBytes, base.workspaceWarnBytes),
    scratchMaxBytes: positiveNumber(quota?.scratchMaxBytes, base.scratchMaxBytes),
    scratchSoftRatio: ratio(quota?.scratchSoftRatio, base.scratchSoftRatio),
    scratchTtlDays: positiveNumber(quota?.scratchTtlDays, base.scratchTtlDays),
    protectRecentMinutes: Number.isFinite(quota?.protectRecentMinutes) && quota.protectRecentMinutes >= 0
      ? quota.protectRecentMinutes
      : base.protectRecentMinutes,
    cleanOnTurnEnd: typeof quota?.cleanOnTurnEnd === 'boolean' ? quota.cleanOnTurnEnd : base.cleanOnTurnEnd,
    toolResultsTtlDays: positiveNumber(quota?.toolResultsTtlDays, base.toolResultsTtlDays),
    snapshotRetentionDays: positiveNumber(quota?.snapshotRetentionDays, base.snapshotRetentionDays),
    userTotalMaxBytes: positiveNumber(quota?.userTotalMaxBytes, base.userTotalMaxBytes),
    imagingScratchMaxBytes: positiveNumber(overrides.scratchMaxBytes, base.imagingScratchMaxBytes),
  };
}

/**
 * 当前生效的配额参数。读不到/解析失败一律回落默认值（绝不抛错）。
 *
 * @param {{ now?: () => number }} [options]
 */
export async function getWorkspaceLimits({ now = Date.now } = {}) {
  const at = now();
  if (cache && cache.expiresAt > at) return cache.limits;

  let limits = { ...DEFAULT_WORKSPACE_LIMITS };
  const configPath = process.env.PILOTDECK_CONFIG_PATH || path.join(resolvePilotRoot(), 'pilotdeck.yaml');
  try {
    const raw = await fsPromises.readFile(configPath, 'utf8');
    limits = normalizeQuota(parseYaml(raw)?.workspace?.quota);
  } catch {
    limits = { ...DEFAULT_WORKSPACE_LIMITS };
  }
  cache = { limits, expiresAt: at + CACHE_TTL_MS };
  return limits;
}

export function invalidateWorkspaceLimitsCache() {
  cache = null;
}
