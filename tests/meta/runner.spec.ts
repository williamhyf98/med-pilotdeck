import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import type { CandidateRecord, CriteriaSet } from "../../src/meta/benchmark/types.js";
import type { FullTextAvailability } from "../../src/meta/fulltext/pmc.js";
import { parseJats, renderDocument } from "../../src/meta/fulltext/jats.js";
import {
  computeLedger,
  createMetaReviewRunner,
  summarizeLedger,
  type FullTextSource,
} from "../../src/meta/runner.js";
import { createMemoryAuditLog, snapshotsFile } from "../../src/meta/state/store.js";
import type { FullTextDecision, ScreeningDecision } from "../../src/meta/types.js";

const CRITERIA: CriteriaSet = {
  source: "article_picos",
  keys: ["P", "S"],
  elements: { P: "Adults with condition X", S: "Randomised controlled trials" },
};

const CANDIDATES: CandidateRecord[] = [
  { pmid: "1", title: "T-exclude", abstract: "A retrospective cohort of adults with condition X." },
  { pmid: "2", title: "T-include", abstract: "A randomised trial in adults with condition X." },
  { pmid: "3", title: "T-fail", abstract: "Something the model cannot handle." },
  { pmid: "4", title: "T-badspan", abstract: "A randomised trial in adults with condition X." },
  { pmid: "5", title: "T-nopmc", abstract: "A randomised trial in adults with condition X." },
];

const JATS = `<pmc-articleset><article><front><article-meta>
<title-group><article-title>T-include</article-title></title-group>
<abstract><p>A randomised trial in adults with condition X.</p></abstract>
</article-meta></front><body>
<sec sec-type="methods"><title>Methods</title><p>We randomised 200 adults with condition X to drug A or placebo.</p></sec>
</body></article></pmc-articleset>`;

const DOC = parseJats(JATS, { pmid: "2", pmcid: "PMC2" });
const METHODS_LOCATOR = [...renderDocument(DOC).locators.keys()].find((key) => key.startsWith("methods"))!;

function abstractDecision(title: string): ScreeningDecision {
  const met = (key: "P" | "S", span: string) => ({ key, verdict: "met" as const, evidenceSpan: span, reason: "" });
  if (title === "T-exclude") {
    return {
      criteriaJudgements: [
        met("P", "adults with condition X"),
        { key: "S", verdict: "not_met", evidenceSpan: "retrospective cohort", reason: "not randomised" },
      ],
      decision: "exclude",
      confidence: "high",
      decisionReason: "S conflicts: retrospective cohort",
    };
  }
  if (title === "T-badspan") {
    return {
      criteriaJudgements: [
        met("P", "adults with condition X"),
        { key: "S", verdict: "not_met", evidenceSpan: "this text does not exist anywhere", reason: "made up" },
      ],
      decision: "exclude",
      confidence: "high",
      decisionReason: "S conflicts (fabricated)",
    };
  }
  return {
    criteriaJudgements: [met("P", "adults with condition X"), met("S", "randomised trial")],
    decision: "include",
    confidence: "high",
    decisionReason: "all met",
  };
}

function fulltextDecision(): FullTextDecision {
  return {
    criteriaJudgements: [
      { key: "P", verdict: "met", evidence: [{ locator: METHODS_LOCATOR, span: "adults with condition X" }], reason: "" },
      { key: "S", verdict: "met", evidence: [{ locator: METHODS_LOCATOR, span: "We randomised 200 adults" }], reason: "" },
    ],
    decision: "include",
    confidence: "high",
    decisionReason: "all met in methods",
  };
}

/** 按标题脚本化的假模型；failTitles 里的标题抛错，模拟调用失败。 */
function fakeModel(failTitles: Set<string>) {
  const calls: string[] = [];
  const client: StructuredModelClient = {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      calls.push(input.name);
      if (input.name === "meta_screen_initial") {
        const title = input.user.match(/标题：(.+)/)?.[1]?.trim() ?? "";
        if (failTitles.has(title)) throw new Error(`fake failure for ${title}`);
        return abstractDecision(title) as unknown as T;
      }
      if (input.name === "meta_screen_fulltext") {
        return fulltextDecision() as unknown as T;
      }
      throw new Error(`unexpected station ${input.name}`);
    },
  };
  return { client, calls };
}

const fakeFullText: FullTextSource = {
  async resolvePmcIds(pmids) {
    const map = new Map<string, string>();
    if (pmids.includes("2")) map.set("2", "PMC2");
    if (pmids.includes("3")) map.set("3", "PMC3");
    return map;
  },
  async get(pmid): Promise<FullTextAvailability> {
    if (pmid === "2" || pmid === "3") return { status: "available", pmid, pmcid: `PMC${pmid}`, doc: { ...DOC, pmid, pmcid: `PMC${pmid}` } };
    return { status: "no_pmc", pmid };
  },
};

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "meta-runner-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("runner commits evidenced exclusions, includes verified full texts, escalates the rest, and retries failures on resume", async () => {
  await withRoot(async (root) => {
    const failing = new Set(["T-fail"]);
    const model = fakeModel(failing);
    const audit = createMemoryAuditLog();
    const runner = createMetaReviewRunner({
      model: model.client,
      stateRoot: root,
      fulltext: fakeFullText,
      concurrency: 2,
      checkpointEvery: 2,
      audit,
    });

    const first = await runner.run({ reviewId: "CD000001", criteria: CRITERIA, candidates: CANDIDATES });
    const items = first.state.items;

    assert.equal(items["1"].stage, "committed");
    assert.equal(items["1"].finalDecision, "exclude");
    assert.equal(items["1"].decidedBy, "model");
    assert.equal(items["1"].criteria.S?.current.verdict, "not_met");
    assert.equal(items["1"].criteria.S?.current.evidenceVerified, true);

    assert.equal(items["2"].finalDecision, "include", "全文全部 met 且引用核实 → 提交纳入");
    assert.equal(items["2"].fullText.status, "available");
    assert.equal(items["2"].criteria.S?.current.origin.stage, "fulltext", "全文观察接替题摘观察");
    assert.equal(items["2"].criteria.S?.observations.length, 2, "题摘阶段的观察仍在历史里");

    assert.equal(items["3"].stage, "candidate", "模型失败的条目留在原阶段");
    assert.equal(items["3"].finalDecision, undefined);
    assert.ok(items["3"].events.some((event) => event.kind === "skipped"));

    assert.equal(items["4"].finalDecision, undefined, "引用核不实的排除不能提交");
    assert.match(items["4"].escalation?.reason ?? "", /无法在原文核实/);
    assert.equal(items["4"].stage, "abstract_screened");

    assert.equal(items["5"].fullText.status, "no_pmc");
    assert.match(items["5"].escalation?.reason ?? "", /全文不可得/);

    const ledger = first.ledger;
    assert.equal(ledger.candidates, 5);
    assert.equal(ledger.abstractScreened, 4);
    assert.equal(ledger.abstractKept, 2, "题摘判 include 的是 2 和 5；4 判了 exclude 但没通过证据门");
    assert.equal(ledger.abstractExcludedByModel, 1);
    assert.equal(ledger.fullTextSought, 2);
    assert.equal(ledger.fullTextAvailable, 1);
    assert.equal(ledger.fullTextUnavailable.noPmc, 1);
    assert.equal(ledger.fullTextIncluded, 1);
    assert.equal(ledger.fullTextUnresolved, 2);
    assert.equal(first.budget.modelCalls, 6, "5 次题摘（含失败那次）+ 1 次全文");
    assert.equal(first.budget.fullTextFetches, 2);
    assert.ok(first.budget.wallClockMs >= 0);
    assert.deepEqual(first.screened, { abstract: 4, fulltext: 1 });

    const snapshots = (await readFile(snapshotsFile(root, "CD000001"), "utf8")).trim().split("\n");
    assert.ok(snapshots.length >= 3, "锁定后、检查点、结束时都落盘");
    assert.ok(audit.events.some((event) => event.step === "abstract" && event.phase === "completed"));

    // 第二轮：失败的条目恢复，其余不重做。
    failing.clear();
    const callsBefore = model.calls.length;
    const second = await runner.run({ reviewId: "CD000001", criteria: CRITERIA, candidates: CANDIDATES });
    assert.deepEqual(second.screened, { abstract: 1, fulltext: 1 }, "只处理上一轮没完成的那一条");
    assert.equal(model.calls.length - callsBefore, 2);
    assert.equal(second.state.round, 2);
    assert.equal(second.state.items["3"].finalDecision, "include");
    assert.equal(second.state.items["4"].escalation?.round, 1, "已转人工的条目不被重复处理");
    assert.equal(second.budget.modelCalls, 8, "预算跨轮累计");

    const summary = summarizeLedger(second.ledger, second.budget);
    assert.match(summary, /candidates=5/);
    assert.match(summary, /included=2/);
  });
});

test("evidence gate off commits exclusions even when the citation cannot be verified", async () => {
  await withRoot(async (root) => {
    const model = fakeModel(new Set());
    const runner = createMetaReviewRunner({
      model: model.client,
      stateRoot: root,
      fulltext: null,
      evidenceGate: false,
      audit: createMemoryAuditLog(),
    });
    const result = await runner.run({
      reviewId: "CD000002",
      criteria: CRITERIA,
      candidates: CANDIDATES.filter((c) => c.title === "T-badspan" || c.title === "T-include"),
    });
    assert.equal(result.state.items["4"].finalDecision, "exclude", "B0 基线：不校验引用直接提交");
    assert.equal(result.state.items["4"].criteria.S?.current.evidenceVerified, false, "但核对结果仍然记录");
    assert.match(result.state.items["2"].escalation?.reason ?? "", /未配置全文来源/);
  });
});

test("changing criteria requires an explicit relock, which resets model decisions but keeps human ones", async () => {
  await withRoot(async (root) => {
    const model = fakeModel(new Set());
    const runner = createMetaReviewRunner({
      model: model.client,
      stateRoot: root,
      fulltext: fakeFullText,
      audit: createMemoryAuditLog(),
    });
    const candidates = CANDIDATES.filter((c) => c.pmid !== "3");
    await runner.run({ reviewId: "CD000003", criteria: CRITERIA, candidates });

    const afterHuman = await runner.applyHumanDecision({
      reviewId: "CD000003",
      pmid: "4",
      decision: "exclude",
      reason: "reviewer confirmed non-randomised",
      actor: "dr-li",
    });
    assert.equal(afterHuman.items["4"].finalDecision, "exclude");
    assert.equal(afterHuman.items["4"].decidedBy, "human");
    assert.equal(afterHuman.items["4"].escalation, undefined);
    assert.equal(afterHuman.budget.humanQueries, 1);
    assert.equal(afterHuman.ledger.abstractExcludedByHuman, 1);

    const changed: CriteriaSet = { ...CRITERIA, elements: { ...CRITERIA.elements, P: "Children with condition X" } };
    await assert.rejects(
      runner.run({ reviewId: "CD000003", criteria: changed, candidates }),
      /differ from locked version 1/,
    );

    const relocked = await runner.run({
      reviewId: "CD000003",
      criteria: changed,
      candidates,
      steps: [],
      allowCriteriaRelock: true,
    });
    assert.equal(relocked.state.criteria?.criteriaVersion, 2);
    assert.equal(relocked.state.items["4"].finalDecision, "exclude", "人工决定不因重新锁定而作废");
    assert.equal(relocked.state.items["1"].stage, "candidate", "模型决定作废，回到候选");
    assert.equal(relocked.state.items["1"].finalDecision, undefined);
    assert.ok(relocked.state.items["1"].criteria.S, "历史观察保留，供后续比较");
    assert.ok(relocked.state.items["1"].events.some((event) => event.kind === "criteria_relocked"));

    const kinds = (await readFile(snapshotsFile(root, "CD000003"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    assert.ok(kinds.includes("human_override"));
    assert.ok(kinds.includes("criteria_relock"));
  });
});

test("ledger is recomputed from items and separates human from model exclusions", () => {
  const ledger = computeLedger({
    a: {
      pmid: "a", title: "", stage: "committed", criteria: {}, fullText: { status: "not_sought" }, events: [],
      abstractDecision: { decision: "exclude", confidence: "high", reason: "", round: 1 },
      finalDecision: "exclude", decidedBy: "model",
    },
    b: {
      pmid: "b", title: "", stage: "committed", criteria: {}, fullText: { status: "available", pmcid: "PMCb" }, events: [],
      abstractDecision: { decision: "include", confidence: "high", reason: "", round: 1 },
      fulltextDecision: { decision: "unresolved", confidence: "low", reason: "", round: 1 },
      finalDecision: "exclude", decidedBy: "human",
    },
    c: {
      pmid: "c", title: "", stage: "fulltext_pending", criteria: {}, fullText: { status: "no_body", pmcid: "PMCc", scanned: true }, events: [],
      abstractDecision: { decision: "include", confidence: "medium", reason: "", round: 1 },
      escalation: { reason: "全文不可得", round: 1 },
    },
  });
  assert.equal(ledger.candidates, 3);
  assert.equal(ledger.abstractExcludedByModel, 1);
  assert.equal(ledger.abstractKept, 2);
  assert.equal(ledger.fullTextExcludedByHuman, 1);
  assert.equal(ledger.fullTextExcludedByModel, 0);
  assert.equal(ledger.fullTextUnavailable.noBody, 1);
  assert.equal(ledger.fullTextUnresolved, 1);
});
