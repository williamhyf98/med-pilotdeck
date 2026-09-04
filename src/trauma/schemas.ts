import type { ExtractedTurnFacts } from "./types.js";

const TURN_KINDS = new Set(["case_update", "correction", "question", "no_case_update"]);
const CERTAINTIES = new Set(["confirmed", "suspected", "excluded", "unknown"]);
const FORBIDDEN_KEYS = new Set([
  "currentStage",
  "currentSubStage",
  "gate",
  "gateAssessment",
  "transition",
  "classification",
  "treatmentPlan",
  "timeline",
]);

/*
 * OpenAI 结构化输出的 strict 模式要求：
 *   - 每个子 schema 都要有 type（或 anyOf）；
 *   - 每个对象都要 additionalProperties: false，且 required 覆盖全部 properties；
 *   - 可选字段只能表达为可空（null），由 StructuredModelClient 在校验前抹掉 null。
 * 下面的构造器负责统一满足这些约束。
 */

type Schema = Record<string, unknown>;

const STRING: Schema = { type: "string" };
const NUMBER: Schema = { type: "number" };
const BOOLEAN: Schema = { type: "boolean" };
const NULLABLE_STRING: Schema = { type: ["string", "null"] };
const NULLABLE_NUMBER: Schema = { type: ["number", "null"] };
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

const MAIN_STAGE = enumOf(
  "battlefield_first_aid",
  "early_treatment",
  "specialist_treatment",
  "rehabilitation",
);

const SUB_STAGE = enumOf(
  "primary_first_aid",
  "advanced_first_aid",
  "emergency_treatment",
  "surgical_resuscitation",
  "field_specialist_treatment",
  "definitive_specialist_treatment",
  "functional_recovery",
  "psychophysical_rehabilitation",
);

function fact(value: Schema): Schema {
  return object({
    value,
    sourceMessageId: STRING,
    sourceQuote: STRING,
    measuredAt: NULLABLE_STRING,
    certainty: enumOf("confirmed", "suspected", "excluded", "unknown"),
    confidence: NUMBER,
    supersedesFactId: NULLABLE_STRING,
  });
}

const VITAL_VALUE = object({
  type: enumOf(
    "respiratory_rate",
    "blood_pressure",
    "heart_rate",
    "spo2",
    "gcs",
    "temperature",
  ),
  /** 血压为 {systolic, diastolic}，其余为单个数值。 */
  value: {
    anyOf: [
      NUMBER,
      object({ systolic: NUMBER, diastolic: NULLABLE_NUMBER }),
    ],
  },
  unit: STRING,
});

const INJURY_VALUE = object({
  bodyPart: STRING,
  finding: STRING,
  status: nullable(enumOf("active", "controlled", "worsening", "improving")),
});

const TREATMENT_VALUE = object({
  action: STRING,
  status: enumOf("planned", "in_progress", "completed"),
  effect: nullable(enumOf("effective", "ineffective", "worsened", "unknown")),
});

const CARE_VALUE = object({
  type: enumOf(
    "capability",
    "capability_gap",
    "destination",
    "transport_mode",
    "transport_constraint",
  ),
  description: STRING,
});

export const EXTRACTED_TURN_FACTS_SCHEMA: Record<string, unknown> = object({
  turnKind: enumOf("case_update", "correction", "question", "no_case_update"),
  context: object({
    eventTime: nullable(fact(STRING)),
    location: nullable(fact(STRING)),
    facility: nullable(fact(STRING)),
  }),
  vitalSigns: arrayOf(fact(VITAL_VALUE)),
  injuryFindings: arrayOf(fact(INJURY_VALUE)),
  treatmentEvents: arrayOf(fact(TREATMENT_VALUE)),
  careAndTransportFacts: arrayOf(fact(CARE_VALUE)),
  correctionsAndProvenance: object({ conflictingFactIds: STRING_ARRAY }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFact(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.sourceQuote === "string"
    && CERTAINTIES.has(String(value.certainty))
    && typeof value.confidence === "number"
    && typeof value.sourceMessageId === "string"
    && "value" in value;
}

function isFactArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isFact);
}

export function validateExtractedTurnFacts(value: unknown): value is ExtractedTurnFacts {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key))) return false;
  if (!TURN_KINDS.has(String(value.turnKind))) return false;
  if (!isRecord(value.context)) return false;
  if (!isFactArray(value.vitalSigns)) return false;
  if (!isFactArray(value.injuryFindings)) return false;
  if (!isFactArray(value.treatmentEvents)) return false;
  if (!isFactArray(value.careAndTransportFacts)) return false;
  if (!isRecord(value.correctionsAndProvenance)) return false;
  if (!Array.isArray(value.correctionsAndProvenance.conflictingFactIds)) return false;
  if (value.extensions !== undefined && !isFactArray(value.extensions)) return false;
  for (const optional of ["eventTime", "location", "facility"] as const) {
    const fact = value.context[optional];
    if (fact !== undefined && !isFact(fact)) return false;
  }
  return true;
}

export type PlannerStationOutput = {
  queries: Array<{
    query: string;
    reason: string;
    critical?: boolean;
  }>;
};

export const PLANNER_OUTPUT_SCHEMA: Record<string, unknown> = object({
  queries: arrayOf(object({
    query: STRING,
    reason: STRING,
    critical: NULLABLE_BOOLEAN,
  })),
});

export function validatePlannerOutput(value: unknown): value is PlannerStationOutput {
  if (!isRecord(value) || !Array.isArray(value.queries)) return false;
  return value.queries.every((item) =>
    isRecord(item)
    && typeof item.query === "string"
    && typeof item.reason === "string"
    && (item.critical === undefined || typeof item.critical === "boolean"),
  );
}

const GATE_STATUSES = new Set(["ASSESSING", "STAY", "BLOCKED", "READY"]);

function withinLimit(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length <= max;
}

function isStringArray(value: unknown, maxItemLength: number): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= maxItemLength);
}

export const REASONER_OUTPUT_SCHEMA: Record<string, unknown> = object({
  naturalLanguageAnswer: STRING,
  classification: object({
    version: NUMBER,
    type: enumOf(
      "emergency_triage",
      "reception_triage",
      "treatment_triage",
      "evacuation_triage",
    ),
    createdAt: STRING,
    severity: enumOf("unknown", "mild", "moderate", "severe", "critical"),
    treatmentPriority: enumOf("pending", "routine", "priority", "urgent"),
    transportPriority: enumOf("pending", "routine", "priority", "urgent"),
    rationale: STRING_ARRAY,
  }),
  treatmentPlan: arrayOf(object({
    id: STRING,
    title: STRING,
    description: STRING,
    scope: enumOf("current_stage", "next_stage"),
    priority: NUMBER,
    evidenceChunkIds: STRING_ARRAY,
    professionalConfirmationRequired: BOOLEAN,
  })),
  missingInformation: STRING_ARRAY,
  transition: object({
    status: enumOf("ASSESSING", "STAY", "BLOCKED", "READY"),
    targetStage: nullable(MAIN_STAGE),
    targetSubStage: nullable(SUB_STAGE),
    reason: STRING,
    requiresUserConfirmation: BOOLEAN,
  }),
  gateAssessment: object({
    needHigherCapability: { anyOf: [BOOLEAN, enumOf("unknown")] },
    requiredCapabilities: STRING_ARRAY,
    targetStage: nullable(MAIN_STAGE),
    targetSubStage: nullable(SUB_STAGE),
    transportReadiness: enumOf("unknown", "ready", "not_ready"),
    instabilityIndicators: STRING_ARRAY,
    blockingFactors: STRING_ARRAY,
    transportPrerequisites: STRING_ARRAY,
    ruleConflicts: arrayOf(object({
      summary: STRING,
      evidenceChunkIds: STRING_ARRAY,
      resolution: NULLABLE_STRING,
      unresolved: BOOLEAN,
    })),
    confidence: NUMBER,
    evidenceChunkIds: STRING_ARRAY,
  }),
  memo: object({
    round: NUMBER,
    mainStage: MAIN_STAGE,
    subStage: SUB_STAGE,
    title: STRING,
    inputPoints: STRING_ARRAY,
    actionPoints: STRING_ARRAY,
    conclusion: STRING,
  }),
});

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
    mainStage: string;
    subStage: string;
    title: string;
    inputPoints: string[];
    actionPoints: string[];
    conclusion: string;
  };
};

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
  if (!withinLimit(value.memo.title, 10)) return false;
  if (!isStringArray(value.memo.inputPoints, 30)) return false;
  if (!isStringArray(value.memo.actionPoints, 30)) return false;
  if (!withinLimit(value.memo.conclusion, 40)) return false;
  for (const action of value.treatmentPlan) {
    if (!isRecord(action) || !Array.isArray(action.evidenceChunkIds)) return false;
  }
  return true;
}
