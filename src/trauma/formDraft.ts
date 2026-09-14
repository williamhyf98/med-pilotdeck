import type { ExtractedTurnForm, TraumaInputIntent, TurnFormInput, VitalItemKey } from "./types.js";

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

export function extractedInputIntent(extracted: ExtractedTurnForm): TraumaInputIntent {
  return extracted.inputIntent ?? "case_update";
}

export function traumaScopeReply(intent: Exclude<TraumaInputIntent, "case_update">): string {
  switch (intent) {
    case "out_of_scope":
      return "当前页面仅支持战创伤救治推演：请提供具体伤员的伤情、生命体征、已实施处置、后送条件和当前救治级别等信息。与战创伤救治推演无关的问题，请切换到通用医学或其他对应智能体处理。";
    case "domain_question_no_case":
      return "这是战创伤救治相关问题，但当前页面用于围绕具体伤员进行推演。请补充本轮伤员的伤情、生命体征、已实施处置、后送条件和当前救治级别等信息后再提交；如需一般知识问答，请切换到通用医学。";
    case "system_help":
      return "这是战创伤救治推演页面。请用自然语言输入本轮伤员的伤情、生命体征、已实施处置、后送条件，并选择或交由系统判断当前救治级别；系统会抽取信息、检索战伤救治规则，并生成处置建议、后送判断和推演记录。";
  }
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
