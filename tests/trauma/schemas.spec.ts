import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTRACTED_TURN_FACTS_SCHEMA,
  PLANNER_OUTPUT_SCHEMA,
  REASONER_OUTPUT_SCHEMA,
  validateExtractedTurnFacts,
  validateReasonerOutput,
} from "../../src/trauma/schemas.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * OpenAI 的 response_format=json_schema + strict 会在服务端校验 schema 本身，
 * 违规直接 400。这里复刻它的硬性约束，避免再把非法 schema 发上游。
 */
function assertStrictCompatible(node: unknown, path: string): void {
  if (!isRecord(node)) return;

  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((branch, index) => assertStrictCompatible(branch, `${path}.anyOf[${index}]`));
    return;
  }

  assert.ok("type" in node, `${path} 缺少 type`);
  const types = Array.isArray(node.type) ? node.type : [node.type];

  if (types.includes("object")) {
    assert.equal(node.additionalProperties, false, `${path} 缺少 additionalProperties: false`);
    const properties = isRecord(node.properties) ? node.properties : {};
    assert.deepEqual(
      [...(node.required as string[] ?? [])].sort(),
      Object.keys(properties).sort(),
      `${path} 的 required 必须覆盖全部 properties`,
    );
    for (const [key, child] of Object.entries(properties)) {
      assertStrictCompatible(child, `${path}.${key}`);
    }
  }

  if (types.includes("array")) {
    assert.ok(node.items !== undefined, `${path} 缺少 items`);
    assertStrictCompatible(node.items, `${path}[]`);
  }
}

test("trauma structured-output schemas satisfy OpenAI strict mode", () => {
  assertStrictCompatible(EXTRACTED_TURN_FACTS_SCHEMA, "extract");
  assertStrictCompatible(PLANNER_OUTPUT_SCHEMA, "plan");
  assertStrictCompatible(REASONER_OUTPUT_SCHEMA, "reason");
});

test("extractor validator still accepts facts once nullable placeholders are stripped", () => {
  assert.equal(
    validateExtractedTurnFacts({
      turnKind: "case_update",
      context: {},
      vitalSigns: [{
        value: { type: "respiratory_rate", value: 32, unit: "/min" },
        sourceMessageId: "user",
        sourceQuote: "呼吸32次",
        certainty: "confirmed",
        confidence: 0.9,
      }],
      injuryFindings: [],
      treatmentEvents: [],
      careAndTransportFacts: [],
      correctionsAndProvenance: { conflictingFactIds: [] },
    }),
    true,
  );
});

test("reasoner validator rejects an over-long memo title", () => {
  const base = {
    naturalLanguageAnswer: "回答",
    classification: {},
    treatmentPlan: [],
    missingInformation: [],
    transition: { status: "STAY", reason: "保持", requiresUserConfirmation: false },
    gateAssessment: { evidenceChunkIds: [] },
    memo: {
      round: 1,
      mainStage: "battlefield_first_aid",
      subStage: "primary_first_aid",
      title: "首轮",
      inputPoints: [],
      actionPoints: [],
      conclusion: "继续观察",
    },
  };
  assert.equal(validateReasonerOutput(base), true);
  assert.equal(
    validateReasonerOutput({ ...base, memo: { ...base.memo, title: "一".repeat(11) } }),
    false,
  );
});
