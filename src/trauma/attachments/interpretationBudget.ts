import type { InterpretationEntry } from "../types.js";

/**
 * 判读天然稀疏（并非每轮都有附件），正常会话的累计量远低于上下文压力线。
 * 这个预算只在极端长会话时兜底，避免 reasoner 那一步以不直观的 400 报错。
 * 取值依据：可用输入约 114k tokens，扣除 system + 病例摘要 + RAG chunk 约 30k
 * 后仍有充裕余量；中文近似 1 char/token。
 */
export const MAX_INTERPRETATION_CHARS = 60000;

const SEPARATOR = "\n\n";
/** 为省略提示预留的字符数，避免裁剪后反而超出预算。 */
const OMISSION_RESERVE = 64;
/** 基线条目单独超出预算时使用的截断标记。 */
const TRUNCATION_MARKER = "…【本轮判读过长，已截断】";

function formatEntry(entry: InterpretationEntry): string {
  const files = entry.fileNames.length > 0
    ? `（附件：${entry.fileNames.join("、")}）`
    : "";
  return `【第 ${entry.round} 轮影像判读】${files}\n${entry.text}`;
}

/** 把 block 硬裁剪到 limit 字符以内，超出时追加截断标记；返回值长度恒不超过 limit。 */
function clipToLimit(block: string, limit: number): string {
  if (limit <= 0) return "";
  if (block.length <= limit) return block;
  const sliceLength = Math.max(limit - TRUNCATION_MARKER.length, 0);
  const clipped = `${block.slice(0, sliceLength)}${TRUNCATION_MARKER}`;
  return clipped.length <= limit ? clipped : clipped.slice(0, limit);
}

/**
 * 把历轮判读拼成给下游模型的上下文文本。默认取全部条目；仅在超出字符预算时
 * 才裁剪，策略为保留最早一条（纵向对比的基线影像）加上从最新往前尽可能多条。
 */
export function buildInterpretationContext(
  entries: InterpretationEntry[],
  maxChars: number = MAX_INTERPRETATION_CHARS,
): string {
  if (entries.length === 0) return "";
  const ordered = entries.slice().sort((left, right) => left.round - right.round);
  const blocks = ordered.map(formatEntry);

  const full = blocks.join(SEPARATOR);
  if (full.length <= maxChars) return full;

  const first = blocks[0] ?? "";
  const kept: string[] = [];
  let used = first.length;
  for (let index = blocks.length - 1; index >= 1; index -= 1) {
    const block = blocks[index] ?? "";
    if (used + block.length + SEPARATOR.length + OMISSION_RESERVE > maxChars) break;
    used += block.length + SEPARATOR.length;
    kept.unshift(block);
  }

  const omittedCount = blocks.length - 1 - kept.length;
  const restParts: string[] = [];
  if (omittedCount > 0) {
    const omittedStartRound = ordered[1]?.round ?? 0;
    const omittedEndRound = ordered[blocks.length - kept.length - 1]?.round ?? omittedStartRound;
    restParts.push(`【已省略第 ${omittedStartRound}–${omittedEndRound} 轮影像判读】`);
  }
  restParts.push(...kept);

  const rest = restParts.length > 0 ? SEPARATOR + restParts.join(SEPARATOR) : "";
  const firstBudget = maxChars - rest.length;
  const firstOut = first.length > firstBudget ? clipToLimit(first, firstBudget) : first;
  return firstOut + rest;
}
