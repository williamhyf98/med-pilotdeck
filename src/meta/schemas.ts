/*
 * 与 src/trauma/schemas.ts 相同的 strict 模式约束：
 *   - 每个子 schema 都要有 type；
 *   - 每个对象都要 additionalProperties: false，且 required 覆盖全部 properties；
 *   - 可选字段只能表达为可空，由 StructuredModelClient 在校验前抹掉 null。
 */

import { PICO_KEYS } from "./benchmark/types.js";
import type { ScreeningDecision, ScreeningVerdict } from "./types.js";

type Schema = Record<string, unknown>;

const STRING: Schema = { type: "string" };

function object(properties: Record<string, Schema>): Schema {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function enumOf(...values: string[]): Schema {
  return { type: "string", enum: values };
}

function described(schema: Schema, description: string): Schema {
  return { ...schema, description };
}

const VERDICT = enumOf("met", "not_met", "not_reported");
const DECISION = enumOf("include", "exclude");
const CONFIDENCE = enumOf("high", "medium", "low");

export const SCREENING_OUTPUT_SCHEMA: Record<string, unknown> = described(
  object({
    criteriaJudgements: {
      type: "array",
      items: object({
        key: enumOf(...PICO_KEYS),
        verdict: VERDICT,
        evidenceSpan: STRING,
        reason: STRING,
      }),
    },
    decision: DECISION,
    confidence: CONFIDENCE,
    decisionReason: STRING,
  }),
  "一条候选文献的题摘筛选判断：逐元素结论与总体纳入排除决定。",
);

const PICO_ELEMENT = enumOf(...PICO_KEYS);

export const CONCEPT_TABLE_SCHEMA: Record<string, unknown> = described(
  object({
    blocks: {
      type: "array",
      items: object({
        element: PICO_ELEMENT,
        label: STRING,
        meshTerms: { type: "array", items: STRING },
        freeTerms: { type: "array", items: STRING },
        rationale: STRING,
      }),
    },
    omittedElements: {
      type: "array",
      items: object({ element: PICO_ELEMENT, reason: STRING }),
    },
  }),
  "检索概念表：每个概念块的主题词与自由词，以及未建块元素的理由。",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateConceptTable(
  value: unknown,
): value is import("./types.js").ConceptTable {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.blocks) || !Array.isArray(value.omittedElements)) return false;
  const blocksOk = value.blocks.every((item) => {
    if (!isRecord(item)) return false;
    if (!PICO_KEYS.includes(item.element as never)) return false;
    if (typeof item.label !== "string" || typeof item.rationale !== "string") return false;
    return isStringArray(item.meshTerms) && isStringArray(item.freeTerms);
  });
  if (!blocksOk) return false;
  return value.omittedElements.every((item) => {
    if (!isRecord(item)) return false;
    return PICO_KEYS.includes(item.element as never) && typeof item.reason === "string";
  });
}

const VERDICTS: readonly string[] = ["met", "not_met", "not_reported"];
const CONFIDENCES: readonly string[] = ["high", "medium", "low"];

export function validateScreeningDecision(value: unknown): value is ScreeningDecision {
  if (!isRecord(value)) return false;
  if (value.decision !== "include" && value.decision !== "exclude") return false;
  if (!CONFIDENCES.includes(String(value.confidence))) return false;
  if (typeof value.decisionReason !== "string") return false;
  if (!Array.isArray(value.criteriaJudgements)) return false;
  return value.criteriaJudgements.every((item) => {
    if (!isRecord(item)) return false;
    if (!PICO_KEYS.includes(item.key as never)) return false;
    if (!VERDICTS.includes(String(item.verdict))) return false;
    return typeof item.evidenceSpan === "string" && typeof item.reason === "string";
  });
}

export function isScreeningVerdict(value: string): value is ScreeningVerdict {
  return VERDICTS.includes(value);
}
