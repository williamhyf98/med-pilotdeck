import type { StructuredModelClient } from "../modelClient.js";
import type { ExtractedTurnForm } from "../types.js";
import { EXTRACTOR_OUTPUT_SCHEMA, validateExtractedTurnForm } from "../schemas.js";
import { EXTRACTOR_SYSTEM_PROMPT } from "./extractorPrompt.js";

export type ExtractorInput = {
  rawText: string;
  caseHistory: string;
  signal?: AbortSignal;
};

export type ExtractionStation = {
  extract(input: ExtractorInput): Promise<ExtractedTurnForm>;
};

/** Few-shot 示例，以 user/assistant 消息对形式注入，与 placementPrompt.ts 的做法一致。 */
const FEW_SHOT_PAIRS: Array<{ user: string; assistant: string }> = [
  {
    user: `<caseHistory></caseHistory>

<currentUserInput>
伤员右小腿开放性骨折，有活动性出血，意识清楚，面色苍白。已完成夹板固定和加压包扎，止血效果良好。心率 102，呼吸 24，体温 36.5。准备后送营救护站，车辆已就位，道路通畅。
</currentUserInput>`,
    assistant: `{"injuryNarratives":[{"text":"伤员右小腿开放性骨折，有活动性出血，意识清楚，面色苍白。","sourceSpan":"伤员右小腿开放性骨折，有活动性出血，意识清楚，面色苍白。"}],"treatmentNarratives":[{"text":"已完成夹板固定和加压包扎，止血效果良好。","sourceSpan":"已完成夹板固定和加压包扎，止血效果良好。"}],"evacuationNarratives":[{"text":"准备后送营救护站，车辆已就位，道路通畅。","sourceSpan":"准备后送营救护站，车辆已就位，道路通畅。"}],"notes":[],"vitals":[{"field":"heartRate","value":102,"unit":"次/分","sourceSpan":"心率 102"},{"field":"respiratoryRate","value":24,"unit":"次/分","sourceSpan":"呼吸 24"},{"field":"temperature","value":36.5,"unit":"℃","sourceSpan":"体温 36.5"}]}`,
  },
  {
    user: `<caseHistory></caseHistory>

<currentUserInput>
腹部锐器伤，伤口约 5 厘米，有少量肠内容物外露，伤员喊痛但意识清楚。
</currentUserInput>`,
    assistant: `{"injuryNarratives":[{"text":"腹部锐器伤，伤口约 5 厘米，有少量肠内容物外露，伤员喊痛但意识清楚。","sourceSpan":"腹部锐器伤，伤口约 5 厘米，有少量肠内容物外露，伤员喊痛但意识清楚。"}],"treatmentNarratives":[],"evacuationNarratives":[],"notes":[],"vitals":[]}`,
  },
  {
    user: `<caseHistory></caseHistory>

<currentUserInput>
血压 92/60，心率 120，血氧 88%，瞳孔等大等圆，对光反射存在。已建立静脉通路，输液中。
</currentUserInput>`,
    assistant: `{"injuryNarratives":[{"text":"血压 92/60，瞳孔等大等圆，对光反射存在。","sourceSpan":"血压 92/60，瞳孔等大等圆，对光反射存在。"}],"treatmentNarratives":[{"text":"已建立静脉通路，输液中。","sourceSpan":"已建立静脉通路，输液中。"}],"evacuationNarratives":[],"notes":[],"vitals":[{"field":"systolicBloodPressure","value":92,"unit":"mmHg","sourceSpan":"血压 92/60"},{"field":"heartRate","value":120,"unit":"次/分","sourceSpan":"心率 120"},{"field":"spo2","value":88,"unit":"%","sourceSpan":"血氧 88%"}]}`,
  },
  {
    user: `<caseHistory></caseHistory>

<currentUserInput>
上一轮说的开放伤不成立，实际只是擦伤，皮肤没有破损。前面报的心率 128 也要更正，刚复测是 104。
</currentUserInput>`,
    assistant: `{"injuryNarratives":[{"text":"上一轮说的开放伤不成立，实际只是擦伤，皮肤没有破损。前面报的心率 128 也要更正，刚复测是 104。","sourceSpan":"上一轮说的开放伤不成立，实际只是擦伤，皮肤没有破损。前面报的心率 128 也要更正，刚复测是 104。"}],"treatmentNarratives":[],"evacuationNarratives":[],"notes":[],"vitals":[{"field":"heartRate","value":104,"unit":"次/分","sourceSpan":"刚复测是 104"}]}`,
  },
];

function buildUserMessage(input: ExtractorInput): string {
  return `<caseHistory>
${input.caseHistory}
</caseHistory>

<currentUserInput>
${input.rawText}
</currentUserInput>`;
}

export function createExtractionStation(model: StructuredModelClient): ExtractionStation {
  return {
    async extract(input: ExtractorInput): Promise<ExtractedTurnForm> {
      // Few-shot 以 user/assistant 消息对格式拼入 user 字符串前缀，
      // completeJson 接受单条 user 字符串，因此将示例序列化为带角色标签的前缀。
      // 这与 placer.ts 使用外部注入消息对的方式不同，
      // 但 StructuredModelClient.completeJson 只暴露单条 user 字段，
      // 所以用 XML 标签内嵌 few-shot 是这里唯一可用的方式。
      const fewShotBlock = FEW_SHOT_PAIRS.map(
        (pair, i) => `<example index="${i + 1}">
<user_turn>
${pair.user}
</user_turn>
<assistant_turn>
${pair.assistant}
</assistant_turn>
</example>`,
      ).join("\n\n");

      const userMessage = `以下是示例输入输出，仅供参考，不得将示例内容混入本次输出：

${fewShotBlock}

现在处理以下输入：

${buildUserMessage(input)}`;

      return model.completeJson({
        name: "trauma_extract_form",
        system: EXTRACTOR_SYSTEM_PROMPT,
        user: userMessage,
        schema: EXTRACTOR_OUTPUT_SCHEMA,
        validate: validateExtractedTurnForm,
        signal: input.signal,
      });
    },
  };
}
