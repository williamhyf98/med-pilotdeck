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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
