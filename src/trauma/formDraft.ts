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
      return "你好！我是战创伤辅助救治助手，当前页面主要用于战创伤伤员的信息整理、分级救治推演、处置建议和后送判断。你刚才的问题不属于战创伤救治范围，因此我无法在这里回答。你可以描述具体伤员的伤情、生命体征、已实施处置、后送条件或当前救治级别；如果需要普通医学问答、天气查询、编程协助等其他服务，请切换到对应的智能体。";
    case "domain_question_no_case":
      return "这是战创伤救治相关知识问题。当前将按知识问答方式回答，不会修改当前病例状态，也不会启动本轮伤员推演。";
    case "system_help":
      return "你好！这里是战创伤辅助救治助手，主要用于围绕具体伤员开展分级救治推演。你可以直接输入“右大腿开放性损伤，持续出血，已用止血带处理，心率 120，准备后送”，也可以补充已实施处置、后送条件、现场环境和当前救治级别。系统会自动抽取信息、检索战伤救治规则，并生成本轮处置建议、后送判断、流程节点和参考来源。如果只想咨询战创伤救治的一般知识，也可以直接提问，系统会进入知识问答模式，不修改当前病例状态。";
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
