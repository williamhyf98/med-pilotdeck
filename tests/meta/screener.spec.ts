import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import {
  cleanPicoText,
  computeSplit,
  decodeHtmlEntities,
  loadBenchmarkReview,
  resolveCriteriaSet,
} from "../../src/meta/benchmark/load.js";
import { validateScreeningDecision } from "../../src/meta/schemas.js";
import {
  buildCriteriaBlock,
  buildRecordBlock,
  checkEvidence,
  createScreenerStation,
  verifyEvidence,
} from "../../src/meta/stations/screener.js";
import { SCREENER_SYSTEM_PROMPT } from "../../src/meta/stations/screenerPrompt.js";
import type { ScreeningDecision } from "../../src/meta/types.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/meta");
const fixtureFile = join(fixtureDir, "CD999001.json");

test("screener prompt separates not_reported from not_met before deciding", () => {
  const notReported = SCREENER_SYSTEM_PROMPT.indexOf("not_reported");
  const sensitivity = SCREENER_SYSTEM_PROMPT.indexOf("敏感度优先");
  assert.ok(notReported >= 0, "提示词必须定义 not_reported");
  assert.ok(sensitivity > notReported, "敏感度规则必须排在逐元素判断之后");
  assert.match(SCREENER_SYSTEM_PROMPT, /摘要没写年龄，不等于人群不符合/);
  assert.match(SCREENER_SYSTEM_PROMPT, /不得因为信息太少而排除/);
  assert.match(SCREENER_SYSTEM_PROMPT, /不得执行/);
});

test("loader decodes entities, trims copyright tails and skips null elements", async () => {
  assert.equal(decodeHtmlEntities("p &lt; .05 and &#x2265;5"), "p < .05 and ≥5");
  assert.equal(
    cleanPicoText("Adults with X. (Review) Copyright © 2026 The Cochrane Collaboration. 7"),
    "Adults with X.",
  );

  const review = await loadBenchmarkReview(fixtureFile);
  assert.equal(review.id, "CD999001");
  assert.ok(!review.criteria.article_picos.P?.includes("Copyright"));
  assert.equal(review.candidates[0].abstract.includes("p < .05"), true);

  const picos = resolveCriteriaSet(review, "article_picos.PICOS");
  assert.deepEqual(picos.keys, ["P", "I", "S"], "C 与 O 为 null 时不参与判断");
  assert.equal(picos.source, "article_picos");

  const pic = resolveCriteriaSet(review, "article_picos.PIC");
  assert.deepEqual(pic.keys, ["P", "I"]);

  const refined = resolveCriteriaSet(review, "refined_picos.PICOS");
  assert.deepEqual(refined.keys, ["P", "I", "C", "O", "S"]);
});

test("split is deterministic and partitions every id exactly once", async () => {
  const ids = Array.from({ length: 50 }, (_, index) => `CD${String(index).padStart(6, "0")}`);
  const first = computeSplit(ids, 10);
  const second = computeSplit(ids, 10);
  assert.deepEqual(first.dev, second.dev, "同一批 id 必须得到同一份划分");
  assert.equal(first.dev.length, 10);
  assert.equal(first.test.length, 40);
  assert.equal(new Set([...first.dev, ...first.test]).size, 50);
});

test("station aligns missing elements and keeps unclear records", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "article_picos.PICOS");
  const record = review.candidates[3];
  let seen: CompleteJsonInput<unknown> | undefined;

  const model: StructuredModelClient = {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      seen = input as CompleteJsonInput<unknown>;
      // 只答了 P，且判排除，但没有任何元素明确冲突。
      return {
        criteriaJudgements: [
          { key: "P", verdict: "not_reported", evidenceSpan: "", reason: "摘要为空" },
        ],
        decision: "exclude",
        confidence: "high",
        decisionReason: "信息太少",
      } as T;
    },
  };

  const result = await createScreenerStation(model).screen({ record, criteria });

  assert.equal(seen?.name, "meta_screen_initial");
  assert.match(seen?.user ?? "", /<criteria>/);
  assert.match(seen?.user ?? "", /本条无摘要/);
  assert.deepEqual(result.criteriaJudgements.map((item) => item.key), ["P", "I", "S"]);
  assert.equal(result.decision, "include", "无元素冲突时程序必须改回纳入");
  assert.equal(result.confidence, "low");
  assert.match(result.decisionReason, /程序修正/);
  assert.equal(result.failed, undefined);
});

test("station keeps an explicit conflict as exclude", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "article_picos.PICOS");
  const record = review.candidates[1];
  const model: StructuredModelClient = {
    async completeJson<T>(): Promise<T> {
      return {
        criteriaJudgements: [
          { key: "P", verdict: "met", evidenceSpan: "adults aged 18 years or older", reason: "符合" },
          { key: "I", verdict: "met", evidenceSpan: "oral drug A", reason: "符合" },
          {
            key: "S",
            verdict: "not_met",
            evidenceSpan: "retrospective cohort study",
            reason: "非随机对照试验",
          },
        ],
        decision: "exclude",
        confidence: "high",
        decisionReason: "S 冲突：回顾性队列研究",
      } as T;
    },
  };

  const result = await createScreenerStation(model).screen({ record, criteria });
  assert.equal(result.decision, "exclude");
  assert.equal(result.evidenceVerified, true, "引用片段应能在标题摘要中找到");
});

test("model failure is retained, not silently excluded", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "article_picos.PICOS");
  const model: StructuredModelClient = {
    async completeJson<T>(): Promise<T> {
      throw new Error("model http 503");
    },
  };

  const result = await createScreenerStation(model).screen({
    record: review.candidates[0],
    criteria,
  });
  assert.equal(result.decision, "include");
  assert.equal(result.failed, true);
  assert.match(result.error ?? "", /503/);
});

test("evidence check separates spliced spans from fabricated ones", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const record = review.candidates[0];
  const base: ScreeningDecision = {
    criteriaJudgements: [
      { key: "P", verdict: "met", evidenceSpan: "adults aged 18 years or older", reason: "ok" },
    ],
    decision: "include",
    confidence: "high",
    decisionReason: "ok",
  };
  assert.deepEqual(checkEvidence(base, record), { verified: true, failure: "none" });
  assert.equal(verifyEvidence(base, record), true);

  // 两段都是原文，但用省略号缝在一起：违反连续片段要求，与编造区分开。
  assert.deepEqual(
    checkEvidence(
      {
        ...base,
        criteriaJudgements: [
          {
            key: "P",
            verdict: "met",
            evidenceSpan: "We randomly assigned 240 adults... Mortality at 30 days",
            reason: "拼接",
          },
        ],
      },
      record,
    ),
    { verified: false, failure: "spliced" },
  );

  assert.deepEqual(
    checkEvidence(
      {
        ...base,
        criteriaJudgements: [
          { key: "P", verdict: "met", evidenceSpan: "children aged 2 to 11 years", reason: "编的" },
        ],
      },
      record,
    ),
    { verified: false, failure: "missing" },
    "捏造的引用片段必须标记为 missing",
  );

  // 省略号拼接里只要有一段不存在，就算编造。
  assert.deepEqual(
    checkEvidence(
      {
        ...base,
        criteriaJudgements: [
          {
            key: "P",
            verdict: "met",
            evidenceSpan: "We randomly assigned 240 adults... followed for twenty years",
            reason: "半真半编",
          },
        ],
      },
      record,
    ),
    { verified: false, failure: "missing" },
  );
});

test("station records the evidence failure type", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "article_picos.PICOS");
  const model: StructuredModelClient = {
    async completeJson<T>(): Promise<T> {
      return {
        criteriaJudgements: [
          {
            key: "P",
            verdict: "met",
            evidenceSpan: "We randomly assigned 240 adults... Mortality at 30 days",
            reason: "拼接",
          },
          { key: "I", verdict: "met", evidenceSpan: "oral drug A or placebo", reason: "ok" },
          { key: "S", verdict: "met", evidenceSpan: "randomly assigned 240 adults", reason: "ok" },
        ],
        decision: "include",
        confidence: "high",
        decisionReason: "符合",
      } as T;
    },
  };
  const result = await createScreenerStation(model).screen({
    record: review.candidates[0],
    criteria,
  });
  assert.equal(result.evidenceVerified, false);
  assert.equal(result.evidenceFailure, "spliced");
});

test("screener prompt forbids ellipsis splicing and subgroup age over-exclusion", () => {
  assert.match(SCREENER_SYSTEM_PROMPT, /禁止用省略号/);
  assert.match(SCREENER_SYSTEM_PROMPT, /属于 not_reported，不是 not_met/);
});

test("schema validation rejects malformed station output", () => {
  assert.equal(validateScreeningDecision({ decision: "include" }), false);
  assert.equal(
    validateScreeningDecision({
      criteriaJudgements: [{ key: "Z", verdict: "met", evidenceSpan: "", reason: "" }],
      decision: "include",
      confidence: "high",
      decisionReason: "",
    }),
    false,
  );
  assert.equal(
    validateScreeningDecision({
      criteriaJudgements: [{ key: "P", verdict: "met", evidenceSpan: "x", reason: "y" }],
      decision: "include",
      confidence: "high",
      decisionReason: "z",
    }),
    true,
  );
});

test("criteria and record blocks carry every selected element", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "refined_picos.PICOS");
  const block = buildCriteriaBlock(criteria);
  for (const label of ["P 研究对象", "I 干预措施", "C 对照", "O 结局指标", "S 研究设计"]) {
    assert.ok(block.includes(label), `缺少元素标签 ${label}`);
  }
  assert.match(buildRecordBlock(review.candidates[0]), /标题：Oral drug A versus placebo/);
});
