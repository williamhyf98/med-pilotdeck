import type { ExtractedTurnForm, TurnFormInput, VitalItemKey } from "./types.js";

const TEXT_LIMITS = {
  injuryNarrative: 1_000,
  treatmentNarrative: 800,
  evacuationNarrative: 500,
  note: 500,
} as const;

function joinAndTruncate(items: Array<{ text: string }>, limit: number): string {
  const joined = items
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
  return joined.slice(0, limit);
}

/**
 * 将工位 F 模型输出的 ExtractedTurnForm 转换为 TurnFormInput 草稿，供用户核对后提交。
 * 纯函数，无副作用。
 *
 * - statedSubStage 始终为 null，由用户自行选择或保持默认。
 * - 同一体征字段出现多个值时，取最后一个（原文最靠后的测量值）。
 * - 各叙述字段按原文顺序拼接后截断至字段上限。
 */
export function normalizeExtractedForm(extracted: ExtractedTurnForm): TurnFormInput {
  const vitals: Partial<Record<VitalItemKey, number>> = {};
  // 同字段多值时后覆盖前，保留最靠后（最新）的测量值
  for (const item of extracted.vitals) {
    vitals[item.field] = item.value;
  }

  return {
    statedSubStage: null,
    injuryNarrative: joinAndTruncate(extracted.injuryNarratives, TEXT_LIMITS.injuryNarrative),
    treatmentNarrative: joinAndTruncate(
      extracted.treatmentNarratives,
      TEXT_LIMITS.treatmentNarrative,
    ),
    evacuationNarrative: joinAndTruncate(
      extracted.evacuationNarratives,
      TEXT_LIMITS.evacuationNarrative,
    ),
    note: joinAndTruncate(extracted.notes, TEXT_LIMITS.note),
    vitals,
  };
}
