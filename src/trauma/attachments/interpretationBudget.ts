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

function formatEntry(entry: InterpretationEntry): string {
  const files = entry.fileNames.length > 0
    ? `（附件：${entry.fileNames.join("、")}）`
    : "";
  return `【第 ${entry.round} 轮影像判读】${files}\n${entry.text}`;
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

  const total = blocks.reduce(
    (sum, block) => sum + block.length + SEPARATOR.length,
    0,
  );
  if (total <= maxChars) return blocks.join(SEPARATOR);

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
  if (omittedCount <= 0) return [first, ...kept].join(SEPARATOR);

  const omittedStartRound = ordered[1]?.round ?? 0;
  const omittedEndRound = ordered[blocks.length - kept.length - 1]?.round ?? omittedStartRound;
  const notice = `【已省略第 ${omittedStartRound}–${omittedEndRound} 轮影像判读】`;
  return [first, notice, ...kept].join(SEPARATOR);
}
