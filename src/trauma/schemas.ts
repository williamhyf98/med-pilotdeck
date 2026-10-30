/*
 * OpenAI 结构化输出的 strict 模式要求：
 *   - 每个子 schema 都要有 type（或 anyOf）；
 *   - 每个对象都要 additionalProperties: false，且 required 覆盖全部 properties；
 *   - 可选字段只能表达为可空（null），由 StructuredModelClient 在校验前抹掉 null。
 * 下面的构造器负责统一满足这些约束。
 */

import { TRAUMA_DEFAULT_REASONER_ANSWER_LENGTH_RULE } from "./presentationDefaults.js";

type Schema = Record<string, unknown>;

const STRING: Schema = { type: "string" };
const NUMBER: Schema = { type: "number" };
const BOOLEAN: Schema = { type: "boolean" };
const NULLABLE_STRING: Schema = { type: ["string", "null"] };
const NULLABLE_BOOLEAN: Schema = { type: ["boolean", "null"] };
const STRING_ARRAY: Schema = { type: "array", items: STRING };

function object(properties: Record<string, Schema>): Schema {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function arrayOf(items: Schema): Schema {
  return { type: "array", items };
}

function enumOf(...values: string[]): Schema {
  return { type: "string", enum: values };
}

function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: "null" }] };
}

function described(schema: Schema, description: string): Schema {
  return { ...schema, description };
}

const MAIN_STAGE = enumOf(
  "battlefield_first_aid",
  "early_treatment",
);

const SUB_STAGE = enumOf(
  "primary_first_aid",
  "advanced_first_aid",
  "emergency_treatment",
  "surgical_resuscitation",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const PLACEMENT_OUTPUT_SCHEMA: Record<string, unknown> = described(
  object({
    determined: BOOLEAN,
    source: enumOf("definition", "undetermined", "out_of_scope"),
    stage: nullable(MAIN_STAGE),
    subStage: nullable(SUB_STAGE),
    rationale: STRING,
    definitionReferences: STRING_ARRAY,
  }),
  "本轮建议采用的战伤救治主级、子级及其依据。",
);

export function validatePlacementAssessment(
  value: unknown,
): value is import("./types.js").PlacementAssessment {
  if (!isRecord(value)) return false;
  if (typeof value.determined !== "boolean") return false;
  if (!["definition", "undetermined", "out_of_scope"].includes(String(value.source))) return false;
  if (typeof value.rationale !== "string" || !Array.isArray(value.definitionReferences)) return false;
  if (value.determined) {
    if (typeof value.stage !== "string" || typeof value.subStage !== "string") return false;
  } else if (
    (value.stage !== undefined && value.stage !== null)
    || (value.subStage !== undefined && value.subStage !== null)
  ) {
    return false;
  }
  return true;
}

export const INTERPRETATION_OUTPUT_SCHEMA: Record<string, unknown> = described(
  object({
    attachments: described(
      arrayOf(object({
        fileName: described(STRING, "附件文件名，必须与输入中给出的文件名一致。"),
        keyFindings: described(
          STRING,
          "该附件完整、可供用户阅读的关键发现。根据材料能力说明资料类型、检查部位、伤类或伤型、严重程度，以及适用时的侧别、方位、体位或视角；保留重要阴性发现、不确定性和判读限制。只描述材料支持的内容，不要推测或罗列检查技术参数。",
        ),
        traumaRelevance: described(
          STRING,
          "该发现与本轮战创伤救治决策的相关性；无相关性时写「与本轮救治决策无直接关联」。",
        ),
      })),
      "按输入附件逐条给出的判读；解析为空的附件也要出现在列表中并说明原因。",
    ),
    overall: described(
      STRING,
      "跨附件的综合判读，汇总共同发现、相互印证或冲突之处、重要不确定性及其对本轮救治的整体意义；没有可综合的内容时为空串。",
    ),
  }),
  "工位 I 的战创伤影像判读输出，供检索与推理消费，也可由 Reasoner 整理为用户可见的影像或附件判读；不是正式影像报告。",
);

export function validateAttachmentInterpretation(
  value: unknown,
): value is import("./types.js").AttachmentInterpretationOutput {
  if (!isRecord(value)) return false;
  if (typeof value.overall !== "string") return false;
  if (!Array.isArray(value.attachments)) return false;
  return value.attachments.every((item: unknown) => (
    isRecord(item)
    && typeof item.fileName === "string"
    && typeof item.keyFindings === "string"
    && typeof item.traumaRelevance === "string"
  ));
}

const GATE_STATUSES = new Set(["ASSESSING", "STAY", "BLOCKED", "READY"]);


export const REASONER_OUTPUT_SCHEMA: Record<string, unknown> = described(
  object({
    naturalLanguageAnswer: described(
      STRING,
      `给用户看的主文。${TRAUMA_DEFAULT_REASONER_ANSWER_LENGTH_RULE}按系统提示词的临床内容要求组织；依据通过句末 [N] 角标引用，不要另写参考依据板块。`,
    ),
    classification: described(
      object({
        version: described(NUMBER, "本轮分类版本号，从 1 起按轮次递增。"),
        type: described(
          enumOf(
            "emergency_triage",
            "reception_triage",
            "treatment_triage",
            "evacuation_triage",
          ),
          "本轮检伤类型，按当前阶段选择，不可照抄上一轮。",
        ),
        createdAt: described(STRING, "本轮分类时间，ISO 8601。"),
        severity: described(
          enumOf("unknown", "mild", "moderate", "severe", "critical"),
          "伤势等级；关键信息不足时用 unknown，不要猜测。",
        ),
        treatmentPriority: described(
          enumOf("pending", "routine", "priority", "urgent"),
          "救治优先级；信息不足用 pending。",
        ),
        transportPriority: described(
          enumOf("pending", "routine", "priority", "urgent"),
          "后送优先级；信息不足用 pending。",
        ),
        rationale: described(STRING_ARRAY, "短句理由，不要粘贴规则原文。"),
      }),
      "本轮重新评估的分类结果，供程序写入分类历史；不可直接沿用上一轮。",
    ),
    treatmentPlan: described(
      arrayOf(object({
        id: described(STRING, "本轮行动 id，如 act-1。"),
        title: described(STRING, "短标题，一句话内说清措施名称。"),
        description: described(
          STRING,
          "一句话说明对谁、在什么条件下做什么。不要写入条款原文或长段论证。",
        ),
        scope: described(
          enumOf("current_stage", "next_stage"),
          "current_stage 仅限当前救治级别允许的措施；更高级别能力必须标 next_stage。",
        ),
        priority: described(NUMBER, "数字越小越优先。"),
        evidenceChunkIds: described(
          STRING_ARRAY,
          "仅填写本轮 promptChunks 中出现的知识块 id；无对应依据则 []，禁止编造。",
        ),
        professionalConfirmationRequired: described(
          BOOLEAN,
          "侵入性或高风险操作为 true。",
        ),
      })),
      "程序读取的行动列表。只保留短标题、短描述和证据 id；依据通过 naturalLanguageAnswer 中的 [N] 角标展示。",
    ),
    missingInformation: described(
      STRING_ARRAY,
      "只列会影响下一步判断或优先级的缺失信息；没有则 []。",
    ),
    transition: described(
      object({
        status: described(
          enumOf("ASSESSING", "STAY", "BLOCKED", "READY"),
          "阶段门状态。规则冲突、依据不足或关键信息缺失时用 ASSESSING。",
        ),
        targetStage: described(
          nullable(MAIN_STAGE),
          "建议转入的主阶段。仅在能确定时填写，否则 null，不要臆造。",
        ),
        targetSubStage: described(
          nullable(SUB_STAGE),
          "建议转入的子阶段。仅在能确定时填写，否则 null。",
        ),
        reason: described(STRING, "一句话说明为何保持、受阻或建议转换。"),
        requiresUserConfirmation: described(
          BOOLEAN,
          "一律为 false；Gate 只作为建议展示，确认卡只用于工位 P 的落位选择。",
        ),
      }),
      "阶段转换建议，供程序判定是否弹出确认卡。",
    ),
    gateAssessment: described(
      object({
        needHigherCapability: described(
          { anyOf: [BOOLEAN, enumOf("unknown")] },
          "是否需要当前机构不具备的更高级能力；无法判断时用 unknown。",
        ),
        requiredCapabilities: described(
          STRING_ARRAY,
          "下一阶段所需能力短名；没有则 []。",
        ),
        targetStage: described(
          nullable(MAIN_STAGE),
          "Gate 建议的目标主阶段；不确定则 null。",
        ),
        targetSubStage: described(
          nullable(SUB_STAGE),
          "Gate 建议的目标子阶段；不确定则 null。",
        ),
        transportReadiness: described(
          enumOf("unknown", "ready", "not_ready"),
          "后送就绪度；体征或伤情不足时用 unknown。",
        ),
        instabilityIndicators: described(
          STRING_ARRAY,
          "提示伤情不稳的短句，须来自已知事实。",
        ),
        blockingFactors: described(
          STRING_ARRAY,
          "阻止转换或后送的因素；没有则 []。",
        ),
        transportPrerequisites: described(
          STRING_ARRAY,
          "后送前仍需满足的条件；没有则 []。",
        ),
        ruleConflicts: described(
          arrayOf(object({
            summary: described(STRING, "冲突要点，一句话。"),
            evidenceChunkIds: described(
              STRING_ARRAY,
              "仅填写本轮 promptChunks 中出现的知识块 id。",
            ),
            resolution: described(
              NULLABLE_STRING,
              "已消解时写消解方式；未消解则 null。",
            ),
            unresolved: described(BOOLEAN, "仍未消解则为 true。"),
          })),
          "规则冲突列表；没有则 []。",
        ),
        confidence: described(
          NUMBER,
          "0 到 1。依据不足或信息缺失时应明显低于 0.75。",
        ),
        evidenceChunkIds: described(
          STRING_ARRAY,
          "本项判定引用的知识块 id，必须来自本轮 promptChunks；没有则 []。",
        ),
      }),
      "Gate 判定明细，供程序读取，不要写成给用户看的长文。",
    ),
    memo: described(
      object({
        round: described(NUMBER, "当前轮次。"),
        mainStage: described(
          nullable(MAIN_STAGE),
          "本轮落位主阶段；未定级则 null。",
        ),
        subStage: described(
          nullable(SUB_STAGE),
          "本轮落位子阶段；未定级则 null。",
        ),
        title: described(STRING, "纪要标题，不超过 10 个字符。"),
        inputPoints: described(
          STRING_ARRAY,
          "本轮输入要点，每条不超过 30 个字符。",
        ),
        actionPoints: described(
          STRING_ARRAY,
          "本轮处置要点，每条不超过 30 个字符。",
        ),
        conclusion: described(STRING, "本轮结论，不超过 40 个字符。"),
      }),
      "流程树用的要点式纪要，禁止复制 naturalLanguageAnswer。",
    ),
  }),
  "工位 B 一轮输出：naturalLanguageAnswer 给人看，其余字段给程序读取。",
);

export type ReasonerStationOutput = {
  naturalLanguageAnswer: string;
  classification: Record<string, unknown>;
  treatmentPlan: Array<Record<string, unknown>>;
  missingInformation: string[];
  transition: {
    status: "ASSESSING" | "STAY" | "BLOCKED" | "READY";
    targetStage?: string;
    targetSubStage?: string;
    reason: string;
    requiresUserConfirmation: boolean;
  };
  gateAssessment: Record<string, unknown>;
  memo: {
    round: number;
    mainStage?: string | null;
    subStage?: string | null;
    title: string;
    inputPoints: string[];
    actionPoints: string[];
    conclusion: string;
  };
};

const VITAL_ITEM_KEY = enumOf(
  "respiratoryRate",
  "systolicBloodPressure",
  "heartRate",
  "temperature",
  "spo2",
);

const EXTRACTED_NARRATIVE_ITEM = object({
  text: STRING,
  sourceSpan: STRING,
});

const EXTRACTED_VITAL_ITEM = object({
  field: VITAL_ITEM_KEY,
  value: NUMBER,
  unit: STRING,
  sourceSpan: STRING,
});

const TRAUMA_INPUT_INTENT = enumOf(
  "case_update",
  "out_of_scope",
  "domain_question_no_case",
  "system_help",
);

const EXTRACTED_PREFERENCE = object({
  sourceSpan: described({ type: "string", maxLength: 500 }, "用户原文中连续存在的偏好片段。"),
  directive: described({ type: "string", maxLength: 300 }, "归一化后的表达或协作偏好。"),
  category: enumOf("format", "detail", "language", "workflow"),
});

export const EXTRACTOR_OUTPUT_SCHEMA: Record<string, unknown> = described(
  object({
    inputIntent: described(
      TRAUMA_INPUT_INTENT,
      "用户本轮输入意图。只有 case_update 表示包含具体伤员信息、可进入推演。",
    ),
    scopeReason: described(
      STRING,
      "一句话说明 inputIntent 的判断依据；不要输出推理过程。",
    ),
    preferences: described(
      { type: "array", items: EXTRACTED_PREFERENCE, maxItems: 8 },
      "与主意图独立的表达、详略、语言或工作流偏好；没有则输出空数组。",
    ),
    injuryNarratives: arrayOf(EXTRACTED_NARRATIVE_ITEM),
    treatmentNarratives: arrayOf(EXTRACTED_NARRATIVE_ITEM),
    evacuationNarratives: arrayOf(EXTRACTED_NARRATIVE_ITEM),
    notes: arrayOf(EXTRACTED_NARRATIVE_ITEM),
    vitals: arrayOf(EXTRACTED_VITAL_ITEM),
  }),
  "工位 F 从用户自由文本中抽取的结构化表单草稿。",
);

export const KNOWLEDGE_QUERY_REWRITE_SCHEMA: Record<string, unknown> = described(
  object({
    rewrittenQueries: arrayOf(object({
      query: STRING,
      reason: STRING,
    })),
    unresolvedReferences: STRING_ARRAY,
    needsClarification: BOOLEAN,
  }),
  "战创伤知识问题的检索查询改写结果。",
);

export function validateKnowledgeQueryRewrite(
  value: unknown,
): value is import("./types.js").KnowledgeQueryRewrite {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.rewrittenQueries)) return false;
  if (!value.rewrittenQueries.every((item: unknown) => (
    isRecord(item)
    && typeof item.query === "string"
    && typeof item.reason === "string"
  ))) return false;
  if (!Array.isArray(value.unresolvedReferences)
    || !value.unresolvedReferences.every((item: unknown) => typeof item === "string")) return false;
  return typeof value.needsClarification === "boolean";
}

export const KNOWLEDGE_QA_OUTPUT_SCHEMA: Record<string, unknown> = described(
  object({
    naturalLanguageAnswer: STRING,
    citationChunkIds: STRING_ARRAY,
  }),
  "战创伤知识问答答案及其引用的知识块 ID。",
);

export function validateKnowledgeQaOutput(
  value: unknown,
): value is import("./types.js").KnowledgeQaOutput {
  if (!isRecord(value)) return false;
  return typeof value.naturalLanguageAnswer === "string"
    && Array.isArray(value.citationChunkIds)
    && value.citationChunkIds.every((item: unknown) => typeof item === "string");
}

function isExtractedNarrativeItem(value: unknown): value is import("./types.js").ExtractedNarrativeItem {
  if (!isRecord(value)) return false;
  return typeof value.text === "string" && typeof value.sourceSpan === "string";
}

function isExtractedVitalItem(value: unknown): value is import("./types.js").ExtractedVitalItem {
  if (!isRecord(value)) return false;
  const validFields = new Set([
    "respiratoryRate", "systolicBloodPressure",
    "heartRate", "temperature", "spo2",
  ]);
  return (
    validFields.has(String(value.field))
    && typeof value.value === "number"
    && typeof value.unit === "string"
    && typeof value.sourceSpan === "string"
  );
}

function isExtractedPreference(value: unknown): value is import("./types.js").ExtractedTraumaPreference {
  if (!isRecord(value)) return false;
  return typeof value.sourceSpan === "string"
    && value.sourceSpan.length <= 500
    && typeof value.directive === "string"
    && value.directive.length <= 300
    && ["format", "detail", "language", "workflow"].includes(String(value.category));
}

export function validateExtractedTurnForm(
  value: unknown,
): value is import("./types.js").ExtractedTurnForm {
  if (!isRecord(value)) return false;
  if (
    value.inputIntent !== undefined
    && !["case_update", "out_of_scope", "domain_question_no_case", "system_help"].includes(String(value.inputIntent))
  ) {
    return false;
  }
  if (value.scopeReason !== undefined && typeof value.scopeReason !== "string") return false;
  if (value.preferences !== undefined) {
    if (!Array.isArray(value.preferences) || value.preferences.length > 8) return false;
    if (!(value.preferences as unknown[]).every(isExtractedPreference)) return false;
  }
  const arrFields = ["injuryNarratives", "treatmentNarratives", "evacuationNarratives", "notes"] as const;
  for (const field of arrFields) {
    if (!Array.isArray(value[field])) return false;
    if (!(value[field] as unknown[]).every(isExtractedNarrativeItem)) return false;
  }
  if (!Array.isArray(value.vitals)) return false;
  if (!(value.vitals as unknown[]).every(isExtractedVitalItem)) return false;
  return true;
}

export function validateReasonerOutput(value: unknown): value is ReasonerStationOutput {
  if (!isRecord(value)) return false;
  if (typeof value.naturalLanguageAnswer !== "string") return false;
  if (!isRecord(value.classification) || !Array.isArray(value.treatmentPlan)) return false;
  if (!Array.isArray(value.missingInformation)) return false;
  if (!isRecord(value.transition) || !GATE_STATUSES.has(String(value.transition.status))) return false;
  if (typeof value.transition.reason !== "string") return false;
  if (typeof value.transition.requiresUserConfirmation !== "boolean") return false;
  if (!isRecord(value.gateAssessment) || !Array.isArray(value.gateAssessment.evidenceChunkIds)) return false;
  if (!isRecord(value.memo)) return false;
  if (typeof value.memo.title !== "string") return false;
  if (!Array.isArray(value.memo.inputPoints) || !value.memo.inputPoints.every((item: unknown) => typeof item === "string")) return false;
  if (!Array.isArray(value.memo.actionPoints) || !value.memo.actionPoints.every((item: unknown) => typeof item === "string")) return false;
  if (typeof value.memo.conclusion !== "string") return false;
  for (const action of value.treatmentPlan) {
    if (!isRecord(action) || !Array.isArray(action.evidenceChunkIds)) return false;
  }
  return true;
}
