import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERPRETATION_OUTPUT_SCHEMA,
  PLACEMENT_OUTPUT_SCHEMA,
  REASONER_OUTPUT_SCHEMA,
  validateAttachmentInterpretation,
  validatePlacementAssessment,
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
  assertStrictCompatible(PLACEMENT_OUTPUT_SCHEMA, "place");
  assertStrictCompatible(REASONER_OUTPUT_SCHEMA, "reason");
});

test("model placement schema rejects user_stated and contains no timing guidance", () => {
  assert.equal(validatePlacementAssessment({
    determined: true,
    source: "user_stated",
    stage: "battlefield_first_aid",
    subStage: "primary_first_aid",
    rationale: "用户明示",
    definitionReferences: [],
  }), false);
  assert.doesNotMatch(JSON.stringify(PLACEMENT_OUTPUT_SCHEMA), /user_stated/);
  assert.doesNotMatch(JSON.stringify(REASONER_OUTPUT_SCHEMA), /建议时间|超过.*时间|时效/);
});

test("reasoner validator accepts over-long memo fields (length is a soft hint, not a hard error)", () => {
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
  // over-long title, inputPoints items, actionPoints items, and conclusion are all accepted
  assert.equal(
    validateReasonerOutput({
      ...base,
      memo: {
        ...base.memo,
        title: "一".repeat(20),
        inputPoints: ["一".repeat(50)],
        actionPoints: ["一".repeat(50)],
        conclusion: "一".repeat(80),
      },
    }),
    true,
  );
  // structural errors (wrong types) still reject
  assert.equal(
    validateReasonerOutput({ ...base, memo: { ...base.memo, title: 123 } }),
    false,
  );
  assert.equal(
    validateReasonerOutput({ ...base, memo: { ...base.memo, inputPoints: "不是数组" } }),
    false,
  );
});

test("interpretation schema satisfies OpenAI strict mode", () => {
  const schema = INTERPRETATION_OUTPUT_SCHEMA as any;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["attachments", "overall"]);
  const item = schema.properties.attachments.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ["fileName", "keyFindings", "traumaRelevance"]);
});

test("validateAttachmentInterpretation accepts a well-formed output", () => {
  assert.equal(validateAttachmentInterpretation({
    attachments: [{ fileName: "ct.dcm", keyFindings: "右侧血气胸", traumaRelevance: "与胸部穿透伤一致" }],
    overall: "提示张力性血气胸风险。",
  }), true);
});

test("validateAttachmentInterpretation accepts an empty attachment list", () => {
  assert.equal(validateAttachmentInterpretation({ attachments: [], overall: "" }), true);
});

test("validateAttachmentInterpretation rejects malformed items", () => {
  assert.equal(validateAttachmentInterpretation({ attachments: [{ fileName: "a" }], overall: "x" }), false);
  assert.equal(validateAttachmentInterpretation({ attachments: "nope", overall: "x" }), false);
  assert.equal(validateAttachmentInterpretation({ attachments: [], overall: 1 }), false);
  assert.equal(validateAttachmentInterpretation(null), false);
});
