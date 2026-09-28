import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import { createBudgetMeter } from "../../src/meta/budget.js";
import {
  createAuditLog,
  loadReviewState,
  saveReviewState,
  snapshotsFile,
} from "../../src/meta/state/store.js";
import {
  initialReviewState,
  isUnsettled,
  mergeObservation,
  observationsFromAbstract,
  observationsFromFullText,
  REVIEW_STATE_SCHEMA_VERSION,
  type CriterionObservation,
} from "../../src/meta/state/types.js";
import type { FullTextPrediction, ScreeningPrediction } from "../../src/meta/types.js";

function observation(
  partial: Partial<CriterionObservation> & { verdict: CriterionObservation["verdict"] },
): CriterionObservation {
  return {
    evidence: [],
    reason: "",
    evidenceVerified: true,
    origin: { stage: "abstract", documentId: "1", round: 1, at: "2026-09-29T00:00:00.000Z" },
    ...partial,
  };
}

// ---- 证据合并：设计文档 §2.3 的"冲突保留、来源可追、历史不丢" ----------

test("first observation becomes current; weaker later observation does not overwrite", () => {
  const fulltext = observation({
    verdict: "met",
    origin: { stage: "fulltext", documentId: "PMC1", round: 1, at: "t1" },
  });
  const state = mergeObservation("S", undefined, fulltext);
  assert.equal(state.current, fulltext);
  assert.equal(state.observations.length, 1);

  const abstractLater = observation({ verdict: "not_reported" });
  const next = mergeObservation("S", state, abstractLater);
  assert.equal(next.current, fulltext, "题摘阶段的观察比全文弱，不能顶掉全文结论");
  assert.equal(next.observations.length, 2, "历史观察必须全部保留");
  assert.equal(next.conflicting.length, 0, "not_reported 与 met 不算矛盾");
});

test("stronger contradicting observation replaces current but keeps the loser as a conflict", () => {
  const abstractNotMet = observation({ verdict: "not_met" });
  const fulltextMet = observation({
    verdict: "met",
    origin: { stage: "fulltext", documentId: "PMC1", round: 2, at: "t2" },
  });
  const state = mergeObservation("P", mergeObservation("P", undefined, abstractNotMet), fulltextMet);
  assert.equal(state.current, fulltextMet);
  assert.deepEqual(state.conflicting, [abstractNotMet], "被替下的矛盾结论进 conflicting，不是静默丢弃");
  assert.equal(isUnsettled(state), true, "存在未消解冲突时元素不算定论");
});

test("weaker contradicting observation is recorded as a conflict without replacing current", () => {
  const humanMet = observation({
    verdict: "met",
    origin: { stage: "human", documentId: "reviewer", round: 1, at: "t1" },
  });
  const modelNotMet = observation({
    verdict: "not_met",
    origin: { stage: "fulltext", documentId: "PMC1", round: 2, at: "t2" },
  });
  const state = mergeObservation("I", mergeObservation("I", undefined, humanMet), modelNotMet);
  assert.equal(state.current, humanMet, "人工结论最强，模型不能覆盖");
  assert.deepEqual(state.conflicting, [modelNotMet]);
});

test("verified evidence outranks unverified evidence at the same stage", () => {
  const unverified = observation({ verdict: "not_met", evidenceVerified: false });
  const verified = observation({ verdict: "met", evidenceVerified: true });
  const state = mergeObservation("O", mergeObservation("O", undefined, unverified), verified);
  assert.equal(state.current, verified);
  assert.deepEqual(state.conflicting, [unverified]);
});

test("isUnsettled is true for not_reported and conflict verdicts", () => {
  assert.equal(isUnsettled(mergeObservation("P", undefined, observation({ verdict: "not_reported" }))), true);
  assert.equal(isUnsettled(mergeObservation("P", undefined, observation({ verdict: "conflict" }))), true);
  assert.equal(isUnsettled(mergeObservation("P", undefined, observation({ verdict: "met" }))), false);
  assert.equal(isUnsettled(mergeObservation("P", undefined, observation({ verdict: "not_met" }))), false);
});

test("station outputs convert to observations with origin and evidence", () => {
  const abstract: ScreeningPrediction = {
    pmid: "42",
    criteriaJudgements: [
      { key: "P", verdict: "met", evidenceSpan: "adults aged 65", reason: "r1" },
      { key: "S", verdict: "not_reported", evidenceSpan: "", reason: "r2" },
    ],
    decision: "include",
    confidence: "medium",
    decisionReason: "",
    evidenceVerified: true,
  };
  const fromAbstract = observationsFromAbstract(abstract, 1, "t1");
  assert.deepEqual(fromAbstract.map((item) => item.key), ["P", "S"]);
  assert.deepEqual(fromAbstract[0].observation.evidence, [{ locator: "", span: "adults aged 65" }]);
  assert.deepEqual(fromAbstract[1].observation.evidence, []);
  assert.equal(fromAbstract[0].observation.origin.stage, "abstract");
  assert.equal(fromAbstract[0].observation.origin.documentId, "42");

  const fulltext: FullTextPrediction = {
    pmid: "42",
    pmcid: "PMC42",
    truncated: false,
    evidenceGate: true,
    criteriaJudgements: [
      { key: "S", verdict: "met", evidence: [{ locator: "methods#1", span: "randomised" }], reason: "" },
    ],
    decision: "include",
    confidence: "high",
    decisionReason: "",
    evidenceVerified: true,
  };
  const fromFullText = observationsFromFullText(fulltext, 2, "t2");
  assert.equal(fromFullText[0].observation.origin.stage, "fulltext");
  assert.equal(fromFullText[0].observation.origin.documentId, "PMC42");
  assert.equal(fromFullText[0].observation.evidence[0].locator, "methods#1");
});

// ---- 持久化：原子写、快照、版本校验 ----------------------------------------

test("store round-trips state, bumps version and appends one snapshot per save", async () => {
  const root = await mkdtemp(join(tmpdir(), "meta-state-"));
  try {
    const initial = initialReviewState("CD000001", "2026-09-29T00:00:00.000Z");
    assert.equal(await loadReviewState(root, "CD000001"), null, "没有文件时返回 null，不是抛错");

    const saved = await saveReviewState(root, initial);
    assert.equal(saved.version, 1);
    const again = await saveReviewState(root, { ...saved, round: 1 }, "human_override");
    assert.equal(again.version, 2);

    const loaded = await loadReviewState(root, "CD000001");
    assert.ok(loaded);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.round, 1);

    const lines = (await readFile(snapshotsFile(root, "CD000001"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2, "每次落盘追加一条快照");
    const kinds = lines.map((line) => (JSON.parse(line) as { kind: string }).kind);
    assert.deepEqual(kinds, ["pipeline_run", "human_override"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store refuses unknown schema versions and mismatched review ids instead of returning empty state", async () => {
  const root = await mkdtemp(join(tmpdir(), "meta-state-"));
  try {
    const state = initialReviewState("CD000002", "2026-09-29T00:00:00.000Z");
    await saveReviewState(root, { ...state, schemaVersion: REVIEW_STATE_SCHEMA_VERSION + 1 });
    await assert.rejects(loadReviewState(root, "CD000002"), /schemaVersion/);

    const other = initialReviewState("CD000003", "2026-09-29T00:00:00.000Z");
    await saveReviewState(root, other);
    // 把 CD000003 的文件冒充成 CD000004 读，必须报错。
    const { copyFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "CD000004"), { recursive: true });
    await copyFile(join(root, "CD000003", "current.json"), join(root, "CD000004", "current.json"));
    await assert.rejects(loadReviewState(root, "CD000004"), /contains CD000003/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit log appends one JSON line per event", async () => {
  const root = await mkdtemp(join(tmpdir(), "meta-audit-"));
  try {
    const audit = createAuditLog(root, "CD000005");
    await audit.record({ reviewId: "CD000005", round: 1, step: "abstract", phase: "started" });
    await audit.record({ reviewId: "CD000005", round: 1, step: "abstract", phase: "completed", detail: { n: 3 } });
    const lines = (await readFile(join(root, "CD000005", "audit.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    const last = JSON.parse(lines[1]) as { phase: string; detail: { n: number }; at: string };
    assert.equal(last.phase, "completed");
    assert.equal(last.detail.n, 3);
    assert.ok(last.at);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- 预算计量：失败的调用也要算 --------------------------------------------

test("budget meter counts every model call including failures and accumulates from a prior state", async () => {
  let calls = 0;
  const flaky: StructuredModelClient = {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { ok: true } as unknown as T;
    },
  };
  const meter = createBudgetMeter({ modelCalls: 10, promptChars: 100 });
  const metered = meter.meterModel(flaky);
  const input: CompleteJsonInput<unknown> = {
    name: "x",
    system: "sys",
    user: "user!",
    schema: {},
    validate: (value): value is unknown => true,
  };
  await assert.rejects(metered.completeJson(input));
  await metered.completeJson(input);
  meter.addFullTextFetches(2);
  meter.addPubMedRequests(3);
  meter.addHumanQueries(1);
  meter.addWallClock(250);
  const usage = meter.snapshot();
  assert.equal(usage.modelCalls, 12, "从 10 起算，两次调用都计入，失败的那次也算");
  assert.equal(usage.promptChars, 100 + 2 * ("sys".length + "user!".length));
  assert.equal(usage.fullTextFetches, 2);
  assert.equal(usage.pubmedRequests, 3);
  assert.equal(usage.humanQueries, 1);
  assert.equal(usage.wallClockMs, 250);
  assert.equal(metered.streamJson, undefined, "底层客户端没有 streamJson 时不凭空造一个");
});
