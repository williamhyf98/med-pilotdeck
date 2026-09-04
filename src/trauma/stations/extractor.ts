import { StructuredOutputSchemaError, type StructuredModelClient } from "../modelClient.js";
import { EXTRACTED_TURN_FACTS_SCHEMA, validateExtractedTurnFacts } from "../schemas.js";
import type { CaseState, ExtractedTurnFacts } from "../types.js";

const EXTRACTOR_SYSTEM_PROMPT = `你是战创伤病例事实抽取工位。只抽取本轮用户文本中明确出现或被更正的事实。

禁止输出：诊断推断、伤势分级、治疗优先级、时效状态、生命体征趋势、治疗方案、所需能力、Gate 判定、阶段变化（currentStage / currentSubStage）。

只返回 JSON。turnKind 只能是 case_update、correction、question、no_case_update。
问候、闲聊或与伤情无关的内容使用 no_case_update，六组核心字段仍要给出（数组可为空）。

每条事实必须包含 sourceQuote、certainty、confidence、sourceMessageId。
sourceMessageId 使用 user。不要编造原文没有的数值或机构。

Schema 中所有字段都必须给出：本轮没有的可空字段（measuredAt、supersedesFactId、context 三项、status、effect、血压舒张压等）一律填 null。
生命体征的 value：血压填 {"systolic": 数值, "diastolic": 数值或 null}，其余指标直接填数值。`;

function compactPrevious(previous: CaseState): unknown {
  const latestVitals = previous.vitalSignsHistory.at(-1);
  return {
    currentStage: previous.currentStage,
    currentSubStage: previous.currentSubStage,
    facility: previous.currentFacility.name,
    injuries: previous.injuries.map((injury) => ({
      id: injury.id,
      bodyPart: injury.bodyPart,
      finding: injury.finding,
      status: injury.status,
    })),
    latestVitals: latestVitals
      ? {
        measuredAt: latestVitals.measuredAt,
        respiratoryRate: latestVitals.respiratoryRate,
        systolicBloodPressure: latestVitals.systolicBloodPressure,
        heartRate: latestVitals.heartRate,
        spo2: latestVitals.spo2,
      }
      : null,
  };
}

export function createExtractorStation(model: StructuredModelClient): {
  extract(input: {
    userText: string;
    previous: CaseState;
    attachmentSummary?: string;
  }): Promise<ExtractedTurnFacts>;
} {
  return {
    async extract(input) {
      const user = [
        `上一版压缩状态：${JSON.stringify(compactPrevious(input.previous))}`,
        input.attachmentSummary ? `附件摘要：${input.attachmentSummary}` : "",
        `本轮用户原文：${input.userText}`,
      ].filter(Boolean).join("\n");

      const facts = await model.completeJson<ExtractedTurnFacts>({
        name: "trauma_extract",
        system: EXTRACTOR_SYSTEM_PROMPT,
        user,
        schema: EXTRACTED_TURN_FACTS_SCHEMA,
        validate: validateExtractedTurnFacts,
      });

      if (!validateExtractedTurnFacts(facts)) {
        throw new StructuredOutputSchemaError("schema validation failed: extractor output");
      }
      return facts;
    },
  };
}
