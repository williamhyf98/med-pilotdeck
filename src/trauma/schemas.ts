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

const extractedFactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["value", "sourceMessageId", "sourceQuote", "certainty", "confidence"],
  properties: {
    value: {},
    sourceMessageId: { type: "string" },
    sourceQuote: { type: "string" },
    measuredAt: { type: "string" },
    certainty: { enum: ["confirmed", "suspected", "excluded", "unknown"] },
    confidence: { type: "number" },
    supersedesFactId: { type: "string" },
  },
};

export const EXTRACTED_TURN_FACTS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "turnKind",
    "context",
    "vitalSigns",
    "injuryFindings",
    "treatmentEvents",
    "careAndTransportFacts",
    "correctionsAndProvenance",
  ],
  properties: {
    turnKind: {
      enum: ["case_update", "correction", "question", "no_case_update"],
    },
    context: {
      type: "object",
      additionalProperties: false,
      properties: {
        eventTime: extractedFactSchema,
        location: extractedFactSchema,
        facility: extractedFactSchema,
      },
    },
    vitalSigns: { type: "array", items: extractedFactSchema },
    injuryFindings: { type: "array", items: extractedFactSchema },
    treatmentEvents: { type: "array", items: extractedFactSchema },
    careAndTransportFacts: { type: "array", items: extractedFactSchema },
    correctionsAndProvenance: {
      type: "object",
      additionalProperties: false,
      required: ["conflictingFactIds"],
      properties: {
        conflictingFactIds: { type: "array", items: { type: "string" } },
      },
    },
    extensions: { type: "array", items: extractedFactSchema },
  },
};

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

export const PLANNER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query", "reason"],
        properties: {
          query: { type: "string" },
          reason: { type: "string" },
          critical: { type: "boolean" },
        },
      },
    },
  },
};

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

export const REASONER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "naturalLanguageAnswer",
    "classification",
    "treatmentPlan",
    "missingInformation",
    "transition",
    "gateAssessment",
    "memo",
  ],
};

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


