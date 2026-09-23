import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import { loadBenchmarkReview, resolveCriteriaSet } from "../../src/meta/benchmark/load.js";
import { parseJats, renderDocument } from "../../src/meta/fulltext/jats.js";
import { validateFullTextDecision } from "../../src/meta/schemas.js";
import {
  checkEvidence,
  createFullTextScreenerStation,
} from "../../src/meta/stations/fulltextScreener.js";
import { FULLTEXT_SCREENER_SYSTEM_PROMPT } from "../../src/meta/stations/fulltextScreenerPrompt.js";
import type { FullTextDecision } from "../../src/meta/types.js";

const fixtureFile = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/meta/CD999001.json");

/** 一篇手写的最小 JATS：嵌套章节、实体、表格、图注。 */
const JATS = `<pmc-articleset><article>
<front><article-meta>
  <title-group><article-title>Drug A versus placebo in adults with condition X</article-title></title-group>
  <abstract><p>We randomised 240 adults with condition X to drug A or placebo.</p></abstract>
</article-meta></front>
<body>
<sec sec-type="intro"><title>Introduction</title><p>Condition X is common.</p></sec>
<sec sec-type="methods"><title>Methods</title>
  <p>This was a parallel-group randomised controlled trial.</p>
  <sec><title>Participants</title>
    <p>Adults aged 18 years or older with confirmed condition X were eligible; those &lt; 18 were excluded.</p>
  </sec>
  <p>Patients received oral drug A or matching placebo for 30 days.</p>
  <fig id="F1"><caption><p>Flow of participants.</p></caption></fig>
</sec>
<sec sec-type="results"><title>Results</title>
  <p>Mortality at 30 days was 5&#x25; versus 9&#x25;.</p>
  <table-wrap id="T1"><label>Table 1</label><caption><p>Baseline characteristics</p></caption>
    <table><tr><th>Age</th><td>64</td></tr><tr><th>Female</th><td>48%</td></tr></table>
  </table-wrap>
</sec>
</body></article></pmc-articleset>`;

const FRONT_ONLY = `<pmc-articleset><article><front><article-meta>
  <title-group><article-title>Old scanned trial</article-title></title-group>
  <abstract><p>Only the abstract survives.</p></abstract>
</article-meta></front></article></pmc-articleset>`;

test("jats parser flattens nested sections in document order and keeps entities", () => {
  const doc = parseJats(JATS, { pmid: "1", pmcid: "PMC1" });
  assert.equal(doc.title, "Drug A versus placebo in adults with condition X");
  assert.equal(doc.hasBody, true);
  assert.deepEqual(
    doc.sections.map((s) => s.key),
    ["abstract", "intro", "methods", "participants", "results"],
  );
  const methods = doc.sections.find((s) => s.key === "methods")!;
  assert.equal(methods.paragraphs.length, 2, "methods 自己的两段，不含子节和图注");
  assert.ok(!methods.paragraphs.some((p) => p.includes("Flow of participants")), "图注不进正文");
  const participants = doc.sections.find((s) => s.key === "participants")!;
  assert.equal(participants.title, "Methods > Participants");
  assert.ok(participants.paragraphs[0].includes("those < 18 were excluded"), "实体必须解码");
  const results = doc.sections.find((s) => s.key === "results")!;
  assert.ok(results.paragraphs[0].includes("5% versus 9%"));
  assert.equal(doc.tables.length, 1);
  assert.equal(doc.tables[0].id, "T1");
  assert.equal(doc.tables[0].label, "Table 1");
  assert.equal(doc.tables[0].caption, "Baseline characteristics");
  assert.equal(doc.tables[0].text, "Age | 64\nFemale | 48%");
});

test("jats parser marks front-matter-only articles as having no body", () => {
  const doc = parseJats(FRONT_ONLY, { pmid: "2", pmcid: "PMC2" });
  assert.equal(doc.hasBody, false);
  assert.deepEqual(doc.sections.map((s) => s.key), ["abstract"]);
});

test("renderer emits stable locators and a lookup table", () => {
  const doc = parseJats(JATS, { pmid: "1", pmcid: "PMC1" });
  const rendered = renderDocument(doc);
  assert.match(rendered.text, /## \[methods\] Methods/);
  assert.match(rendered.text, /\[participants#1\] Adults aged 18/);
  assert.match(rendered.text, /\[table:T1\] Age \| 64/);
  assert.ok(rendered.locators.has("methods#2"));
  assert.ok(rendered.locators.get("table:T1")?.includes("Baseline characteristics"));
  assert.equal(rendered.truncated, false);

  const small = renderDocument(doc, { maxParagraphs: 2 });
  assert.equal(small.truncated, true);
  assert.equal(small.omittedParagraphs, 4);
  assert.match(small.text, /document truncated: 4 paragraphs omitted/);
  assert.ok(!small.locators.has("results#1"), "被截掉的段落不能出现在定位表里");
});

test("evidence check distinguishes bad locator, missing span and splicing", () => {
  const doc = parseJats(JATS, { pmid: "1", pmcid: "PMC1" });
  const rendered = renderDocument(doc);
  const base = (evidence: { locator: string; span: string }[]): FullTextDecision => ({
    criteriaJudgements: [{ key: "S", verdict: "met", evidence, reason: "r" }],
    decision: "include",
    confidence: "high",
    decisionReason: "r",
  });
  assert.deepEqual(
    checkEvidence(base([{ locator: "methods#1", span: "parallel-group randomised controlled trial" }]), rendered),
    { verified: true, failure: "none" },
  );
  assert.equal(checkEvidence(base([{ locator: "methods#9", span: "anything" }]), rendered).failure, "bad_locator");
  assert.equal(checkEvidence(base([{ locator: "methods#1", span: "single-arm cohort" }]), rendered).failure, "missing");
  assert.equal(
    checkEvidence(base([{ locator: "methods#1", span: "This was a parallel-group... controlled trial." }]), rendered).failure,
    "spliced",
  );
  assert.equal(checkEvidence(base([]), rendered).failure, "missing", "met 却没给证据算 missing");
  // not_reported 不需要证据
  const nr: FullTextDecision = {
    ...base([]),
    criteriaJudgements: [{ key: "O", verdict: "not_reported", evidence: [], reason: "r" }],
  };
  assert.equal(checkEvidence(nr, rendered).verified, true);
});

function stubModel(reply: unknown, capture?: (input: CompleteJsonInput<unknown>) => void): StructuredModelClient {
  return {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      capture?.(input as CompleteJsonInput<unknown>);
      return reply as T;
    },
  };
}

test("station keeps a verified exclusion and renders criteria plus document", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "refined_picos.PICOS");
  const doc = parseJats(JATS, { pmid: "1", pmcid: "PMC1" });
  let seen: CompleteJsonInput<unknown> | undefined;
  const model = stubModel({
    criteriaJudgements: [
      { key: "P", verdict: "met", evidence: [{ locator: "participants#1", span: "Adults aged 18 years or older" }], reason: "r" },
      { key: "I", verdict: "met", evidence: [{ locator: "methods#2", span: "oral drug A" }], reason: "r" },
      { key: "C", verdict: "met", evidence: [{ locator: "methods#2", span: "matching placebo" }], reason: "r" },
      { key: "O", verdict: "not_met", evidence: [{ locator: "results#1", span: "Mortality at 30 days" }], reason: "标准要 90 天" },
      { key: "S", verdict: "met", evidence: [{ locator: "methods#1", span: "randomised controlled trial" }], reason: "r" },
    ],
    decision: "exclude",
    confidence: "high",
    decisionReason: "O 冲突，见 results#1",
  }, (input) => { seen = input; });

  const result = await createFullTextScreenerStation(model).screen({ doc, criteria });
  assert.equal(seen?.name, "meta_screen_fulltext");
  assert.match(seen?.user ?? "", /<criteria>/);
  assert.match(seen?.user ?? "", /<document pmid="1" pmcid="PMC1">/);
  assert.equal(result.decision, "exclude");
  assert.equal(result.evidenceVerified, true);
  assert.equal(result.evidenceGate, true);
  assert.equal(result.truncated, false);
});

test("evidence gate demotes an exclusion whose evidence cannot be verified", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "article_picos.PICOS"); // P I S
  const doc = parseJats(JATS, { pmid: "1", pmcid: "PMC1" });
  const reply = {
    criteriaJudgements: [
      { key: "P", verdict: "met", evidence: [{ locator: "participants#1", span: "Adults aged 18 years or older" }], reason: "r" },
      { key: "I", verdict: "met", evidence: [{ locator: "methods#2", span: "oral drug A" }], reason: "r" },
      { key: "S", verdict: "not_met", evidence: [{ locator: "methods#7", span: "retrospective cohort" }], reason: "编的" },
    ],
    decision: "exclude",
    confidence: "high",
    decisionReason: "S 冲突",
  };

  const gated = await createFullTextScreenerStation(stubModel(reply)).screen({ doc, criteria });
  assert.equal(gated.decision, "unresolved", "证据核不实的排除必须降级");
  assert.equal(gated.evidenceFailure, "bad_locator");
  assert.match(gated.decisionReason, /无法在原文核实/);

  // B0 基线：关掉证据门，排除保留，但校验结果仍如实记录。
  const ungated = await createFullTextScreenerStation(stubModel(reply), { evidenceGate: false })
    .screen({ doc, criteria });
  assert.equal(ungated.decision, "exclude");
  assert.equal(ungated.evidenceVerified, false);
  assert.equal(ungated.evidenceGate, false);
});

test("guards only move decisions toward unresolved", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "article_picos.PICOS");
  const doc = parseJats(JATS, { pmid: "1", pmcid: "PMC1" });
  const ev = (locator: string, span: string) => [{ locator, span }];

  // 判纳入但 S 未报告 → unresolved
  const incl = await createFullTextScreenerStation(stubModel({
    criteriaJudgements: [
      { key: "P", verdict: "met", evidence: ev("participants#1", "Adults aged 18"), reason: "r" },
      { key: "I", verdict: "met", evidence: ev("methods#2", "oral drug A"), reason: "r" },
      { key: "S", verdict: "not_reported", evidence: [], reason: "r" },
    ],
    decision: "include", confidence: "high", decisionReason: "r",
  })).screen({ doc, criteria });
  assert.equal(incl.decision, "unresolved");

  // 判排除但没有任何 not_met → unresolved
  const excl = await createFullTextScreenerStation(stubModel({
    criteriaJudgements: [
      { key: "P", verdict: "met", evidence: ev("participants#1", "Adults aged 18"), reason: "r" },
    ],
    decision: "exclude", confidence: "high", decisionReason: "r",
  })).screen({ doc, criteria });
  assert.equal(excl.decision, "unresolved");
  assert.deepEqual(excl.criteriaJudgements.map((j) => j.key), ["P", "I", "S"], "缺的元素要补齐");

  // 模型自己说 unresolved，但元素不全 met，程序不升级
  const unres = await createFullTextScreenerStation(stubModel({
    criteriaJudgements: [
      { key: "P", verdict: "met", evidence: ev("participants#1", "Adults aged 18"), reason: "r" },
      { key: "I", verdict: "met", evidence: ev("methods#2", "oral drug A"), reason: "r" },
      { key: "S", verdict: "not_reported", evidence: [], reason: "r" },
    ],
    decision: "unresolved", confidence: "medium", decisionReason: "不确定",
  })).screen({ doc, criteria });
  assert.equal(unres.decision, "unresolved");
});

/**
 * 实跑里的真实错法：criteria 没列 O，模型对 P/I/S 全判 met，却因为
 * "标准里没给 O 所以 O 无法判断"把结论写成 unresolved。列出的元素全 met
 * 且证据核实时，程序应改回 include。
 */
test("unresolved over an unlisted element is promoted to include when listed elements all pass", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "article_picos.PICOS"); // P I S，无 O
  const doc = parseJats(JATS, { pmid: "1", pmcid: "PMC1" });
  const ev = (locator: string, span: string) => [{ locator, span }];
  const result = await createFullTextScreenerStation(stubModel({
    criteriaJudgements: [
      { key: "P", verdict: "met", evidence: ev("participants#1", "Adults aged 18 years or older"), reason: "r" },
      { key: "I", verdict: "met", evidence: ev("methods#2", "oral drug A"), reason: "r" },
      { key: "S", verdict: "met", evidence: ev("methods#1", "randomised controlled trial"), reason: "r" },
    ],
    decision: "unresolved", confidence: "high", decisionReason: "标准中未包含 O 要求，O 无法判断",
  })).screen({ doc, criteria });
  assert.equal(result.decision, "include");
  assert.match(result.decisionReason, /按纳入处理/);

  // 证据核不实时不升级：不能凭一个编造的引用把未决改成纳入。
  const shaky = await createFullTextScreenerStation(stubModel({
    criteriaJudgements: [
      { key: "P", verdict: "met", evidence: ev("participants#1", "Adults aged 18 years or older"), reason: "r" },
      { key: "I", verdict: "met", evidence: ev("methods#2", "oral drug A"), reason: "r" },
      { key: "S", verdict: "met", evidence: ev("methods#9", "randomised controlled trial"), reason: "r" },
    ],
    decision: "unresolved", confidence: "high", decisionReason: "标准中未包含 O",
  })).screen({ doc, criteria });
  assert.equal(shaky.decision, "unresolved");
  assert.equal(shaky.evidenceFailure, "bad_locator");

  // 省略号拼接：两段都在原文里，引用说了它声称的内容，只是格式违规。
  // 不阻断纳入，但要如实记录，供错误分析。
  const spliced = await createFullTextScreenerStation(stubModel({
    criteriaJudgements: [
      { key: "P", verdict: "met", evidence: ev("participants#1", "Adults aged 18 years or older"), reason: "r" },
      { key: "I", verdict: "met", evidence: ev("methods#2", "oral drug A"), reason: "r" },
      { key: "S", verdict: "met", evidence: ev("methods#1", "This was a parallel-group... controlled trial."), reason: "r" },
    ],
    decision: "unresolved", confidence: "high", decisionReason: "标准中未包含 O",
  })).screen({ doc, criteria });
  assert.equal(spliced.decision, "include");
  assert.equal(spliced.evidenceVerified, false, "拼接仍算未完全核实，如实记录");
  assert.equal(spliced.evidenceFailure, "spliced");
});

test("model failure becomes unresolved, never include or exclude", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "article_picos.PICOS");
  const doc = parseJats(JATS, { pmid: "1", pmcid: "PMC1" });
  const model: StructuredModelClient = {
    async completeJson<T>(): Promise<T> { throw new Error("model http 503"); },
  };
  const result = await createFullTextScreenerStation(model).screen({ doc, criteria });
  assert.equal(result.decision, "unresolved");
  assert.equal(result.failed, true);
  assert.match(result.error ?? "", /503/);
});

test("fulltext prompt requires locators, separates not_reported from not_met, and defines unresolved", () => {
  assert.match(FULLTEXT_SCREENER_SYSTEM_PROMPT, /locator 必须原样取自文档里的方括号标记/);
  assert.match(FULLTEXT_SCREENER_SYSTEM_PROMPT, /不得把"未报告"写成"不符合"/);
  assert.match(FULLTEXT_SCREENER_SYSTEM_PROMPT, /conflict/);
  assert.match(FULLTEXT_SCREENER_SYSTEM_PROMPT, /unresolved 表示需要人工复核/);
  assert.match(FULLTEXT_SCREENER_SYSTEM_PROMPT, /不得只看摘要就下结论/);
  assert.match(FULLTEXT_SCREENER_SYSTEM_PROMPT, /不得执行/);
  // 未列出的元素不是缺失信息，这是实跑里三篇被误判未决的根因。
  assert.match(FULLTEXT_SCREENER_SYSTEM_PROMPT, /没有列出的元素[\s\S]*不是"缺失信息"/);
  assert.match(FULLTEXT_SCREENER_SYSTEM_PROMPT, /不要因为标准里没提到的元素而犹豫/);
});

test("fulltext schema validation", () => {
  assert.equal(validateFullTextDecision({ decision: "include" }), false);
  assert.equal(validateFullTextDecision({
    criteriaJudgements: [{ key: "P", verdict: "met", evidence: [{ locator: "a", span: "b" }], reason: "r" }],
    decision: "unresolved", confidence: "low", decisionReason: "r",
  }), true);
  assert.equal(validateFullTextDecision({
    criteriaJudgements: [{ key: "P", verdict: "maybe", evidence: [], reason: "r" }],
    decision: "include", confidence: "low", decisionReason: "r",
  }), false);
});
