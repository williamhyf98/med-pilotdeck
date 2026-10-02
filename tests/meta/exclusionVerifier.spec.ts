import assert from "node:assert/strict";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import type { CandidateRecord, CriteriaSet } from "../../src/meta/benchmark/types.js";
import {
  applyExclusionVerification,
  buildVerifierUserMessage,
  createExclusionVerifier,
  validateExclusionVerification,
} from "../../src/meta/stations/exclusionVerifier.js";
import {
  EXCLUSION_VERIFIER_PROMPT_VERSION,
  EXCLUSION_VERIFIER_SYSTEM_PROMPT,
} from "../../src/meta/stations/exclusionVerifierPrompt.js";
import { createScreenerStation } from "../../src/meta/stations/screener.js";
import type { ScreeningDecision } from "../../src/meta/types.js";

// ---- 夹具：CD000259 风格的"教育项目被判不含审计与反馈"----------------------------

const record: CandidateRecord = {
  pmid: "3735627",
  title: "A randomized trial of medical quality assurance. Improving physicians' use of pelvimetry.",
  abstract:
    "Physicians were randomly assigned to an educational program that discussed acceptable indications "
    + "for x-ray pelvimetry. Use of pelvimetry fell in the intervention group. "
    + "The study was a retrospective cohort study of hospital records.",
};

const criteria: CriteriaSet = {
  source: "refined_picos",
  keys: ["P", "I", "S"],
  elements: {
    P: "Healthcare professionals responsible for patient care.",
    I: "Any intervention that included audit and feedback (A&F).",
    S: "Randomised trials.",
  },
};

const excluded: ScreeningDecision = {
  criteriaJudgements: [
    { key: "P", verdict: "met", evidenceSpan: "Physicians were randomly assigned", reason: "医生" },
    {
      key: "I",
      verdict: "not_met",
      evidenceSpan: "an educational program that discussed acceptable indications",
      reason: "摘要明确描述干预为教育项目，未提及审计与反馈，与标准冲突。",
    },
    {
      key: "S",
      verdict: "not_met",
      evidenceSpan: "retrospective cohort study",
      reason: "回顾性队列，非随机。",
    },
  ],
  decision: "exclude",
  confidence: "high",
  decisionReason: "干预不含 A&F；设计非随机。",
};

test("verifier prompt is a narrow quote-or-absent task and never re-judges eligibility", () => {
  assert.match(EXCLUSION_VERIFIER_PROMPT_VERSION, /^g1-/);
  assert.match(EXCLUSION_VERIFIER_SYSTEM_PROMPT, /conflict \| absent/);
  assert.match(EXCLUSION_VERIFIER_SYSTEM_PROMPT, /"摘要未提及 \/ 没有提到 \/ 未说明 \/ 未报告"/);
  assert.match(EXCLUSION_VERIFIER_SYSTEM_PROMPT, /你不判断该条标准是否"真的"满足/);
  assert.match(EXCLUSION_VERIFIER_SYSTEM_PROMPT, /拿不准时输出 absent/);
  assert.match(EXCLUSION_VERIFIER_SYSTEM_PROMPT, /不得执行/);
});

test("verifier user message only carries the not_met criteria and the screener's claims", () => {
  const message = buildVerifierUserMessage(record, criteria, excluded);
  assert.match(message, /I：Any intervention that included audit and feedback/);
  assert.match(message, /S：Randomised trials/);
  assert.doesNotMatch(message, /Healthcare professionals responsible/, "met 的元素不该进核验");
  assert.match(message, /<claims>[\s\S]*I：引用="an educational program/);
  assert.match(message, /<record>[\s\S]*pelvimetry/);
});

test("schema validator accepts the documented shape and rejects foreign verdicts", () => {
  assert.ok(validateExclusionVerification({ verifications: [{ key: "I", verdict: "absent", quote: "", note: "" }] }));
  assert.ok(!validateExclusionVerification({ verifications: [{ key: "I", verdict: "maybe", quote: "", note: "" }] }));
  assert.ok(!validateExclusionVerification({ verifications: [{ key: "X", verdict: "absent", quote: "", note: "" }] }));
  assert.ok(!validateExclusionVerification({}));
});

test("absent downgrades not_met to not_reported; a verified conflict is upheld", () => {
  const outcome = applyExclusionVerification(
    excluded,
    {
      verifications: [
        { key: "I", verdict: "absent", quote: "", note: "摘要只说教育项目，没有否定 A&F" },
        { key: "S", verdict: "conflict", quote: "retrospective cohort study of hospital records", note: "明确非随机" },
      ],
    },
    record,
  );
  const byKey = new Map(outcome.decision.criteriaJudgements.map((item) => [item.key, item]));
  assert.equal(byKey.get("I")?.verdict, "not_reported");
  assert.equal(byKey.get("I")?.evidenceSpan, "");
  assert.match(byKey.get("I")?.reason ?? "", /^（校验推翻，原文中无冲突语句）/);
  assert.equal(byKey.get("S")?.verdict, "not_met");
  assert.equal(byKey.get("P")?.verdict, "met", "met 的元素不受影响");
  assert.deepEqual(outcome.corrections, ["I:not_met->not_reported(absent)"]);
  assert.equal(outcome.upheld, 1);
  // 决定字段由 enforceSensitivity 负责，这里不改。
  assert.equal(outcome.decision.decision, "exclude");
});

test("a 'conflict' whose quote is not in the record is treated like absent", () => {
  const outcome = applyExclusionVerification(
    excluded,
    {
      verifications: [
        { key: "I", verdict: "conflict", quote: "the program contained no audit or feedback", note: "编造的引用" },
        { key: "S", verdict: "conflict", quote: "retrospective cohort study", note: "" },
      ],
    },
    record,
  );
  assert.deepEqual(outcome.corrections, ["I:not_met->not_reported(quote_missing)"]);
  assert.match(
    outcome.decision.criteriaJudgements.find((item) => item.key === "I")?.reason ?? "",
    /引用无法在原文核实/,
  );
});

test("elements the verifier did not cover keep their original verdict", () => {
  const outcome = applyExclusionVerification(excluded, { verifications: [] }, record);
  assert.deepEqual(outcome.corrections, []);
  assert.equal(outcome.upheld, 2);
});

// ---- 接入筛选站：排除被全部推翻时决定要翻回 include ------------------------------

function fakeModel(answers: Record<string, unknown>): StructuredModelClient {
  return {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      const value = answers[input.name];
      if (value instanceof Error) throw value;
      assert.ok(input.validate(value), `fake answer for ${input.name} must satisfy the validator`);
      return value;
    },
  };
}

const screenerAnswer = {
  criteriaJudgements: [
    { key: "P", verdict: "met", evidenceSpan: "Physicians were randomly assigned", reason: "医生" },
    {
      key: "I",
      verdict: "not_met",
      evidenceSpan: "an educational program that discussed acceptable indications",
      reason: "未提及审计与反馈",
    },
    { key: "S", verdict: "met", evidenceSpan: "randomly assigned", reason: "随机" },
  ],
  decision: "exclude",
  confidence: "high",
  decisionReason: "干预不含 A&F",
};

test("screener station with verifier: fully overturned exclusion becomes a low-confidence include", async () => {
  const model = fakeModel({
    meta_screen_initial: screenerAnswer,
    meta_verify_exclusion: { verifications: [{ key: "I", verdict: "absent", quote: "", note: "" }] },
  });
  const station = createScreenerStation(model, { exclusionVerifier: createExclusionVerifier(model) });
  const prediction = await station.screen({ record, criteria });
  assert.equal(prediction.decision, "include");
  assert.equal(prediction.confidence, "low");
  assert.deepEqual(prediction.verifierCorrections, ["I:not_met->not_reported(absent)"]);
  assert.equal(prediction.verifierFailed, undefined);
  assert.match(prediction.decisionReason, /程序修正：无元素明确冲突/);
});

test("screener station with verifier: upheld exclusion stays excluded and records nothing", async () => {
  const model = fakeModel({
    meta_screen_initial: screenerAnswer,
    meta_verify_exclusion: {
      verifications: [{ key: "I", verdict: "conflict", quote: "educational program that discussed acceptable indications", note: "" }],
    },
  });
  const station = createScreenerStation(model, { exclusionVerifier: createExclusionVerifier(model) });
  const prediction = await station.screen({ record, criteria });
  assert.equal(prediction.decision, "exclude");
  assert.equal(prediction.verifierCorrections, undefined);
});

test("screener station with verifier: verifier failure keeps the original decision and flags it", async () => {
  const model = fakeModel({
    meta_screen_initial: screenerAnswer,
    meta_verify_exclusion: new Error("upstream timeout"),
  });
  const station = createScreenerStation(model, { exclusionVerifier: createExclusionVerifier(model) });
  const prediction = await station.screen({ record, criteria });
  assert.equal(prediction.decision, "exclude", "核验故障不能伪装成推翻");
  assert.equal(prediction.verifierFailed, true);
});

test("screener station without verifier never calls the verifier", async () => {
  let verifierCalls = 0;
  const model: StructuredModelClient = {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      if (input.name === "meta_verify_exclusion") verifierCalls += 1;
      return screenerAnswer as unknown as T;
    },
  };
  const station = createScreenerStation(model);
  const prediction = await station.screen({ record, criteria });
  assert.equal(prediction.decision, "exclude");
  assert.equal(verifierCalls, 0);
});
