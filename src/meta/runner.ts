/**
 * MetaReviewRunner：把题摘筛选与全文筛选串成一个有状态、可断点续跑的流程。
 *
 * 它是设计文档里"运行系统"那一层的最小实现：
 *   - 状态（state/types.ts）：每条文献的阶段、逐元素证据、最终决定、人工队列；
 *   - 提交规则（§2.4）：一条有可核实证据的 not_met 可以排除；纳入要求列出的元素全部 met；
 *     其余情况一律转人工，不猜；
 *   - 预算（budget.ts）：模型调用、全文获取、人工询问全部计入；
 *   - 可恢复（RQ4 的最低要求）：每处理若干条落一次盘，重跑时只处理还没到位的条目；
 *     模型调用失败的条目留在原阶段，下次重跑自动重试，不会伪装成排除。
 *
 * 它不负责"什么研究设计符合协议"——那是工位提示词和纳排标准的事。这里只检查
 * 引用是否成立、状态是否允许提交，这条边界与文档 §1 一致。
 */
import type { StructuredModelClient } from "../trauma/modelClient.js";
import type { CandidateRecord, CriteriaSet } from "./benchmark/types.js";
import { createBudgetMeter, type BudgetMeter } from "./budget.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { FullTextAvailability } from "./fulltext/pmc.js";
import { createFullTextScreenerStation } from "./stations/fulltextScreener.js";
import { createScreenerStation } from "./stations/screener.js";
import {
  createAuditLog,
  loadReviewState,
  saveReviewState,
  type AuditLog,
  type SnapshotKind,
} from "./state/store.js";
import {
  emptyLedger,
  initialReviewState,
  mergeObservation,
  observationsFromAbstract,
  observationsFromFullText,
  type BudgetUsage,
  type DecisionActor,
  type FinalDecision,
  type FullTextAccess,
  type ItemState,
  type LockedCriteria,
  type PrismaLedger,
  type ReviewState,
  type SearchRecord,
} from "./state/types.js";
import type { FullTextPrediction, ScreeningPrediction } from "./types.js";

export type RunnerStep = "abstract" | "fulltext";

/** 全文来源。生产环境是 fulltext/pmc.ts 的客户端，测试里用假的。 */
export type FullTextSource = {
  resolvePmcIds(pmids: readonly string[]): Promise<Map<string, string>>;
  get(pmid: string, knownPmcid?: string): Promise<FullTextAvailability>;
};

export type RunnerProgress = {
  step: RunnerStep;
  done: number;
  total: number;
};

export type ReviewRunInput = {
  reviewId: string;
  /** 题摘阶段的纳排标准。首次运行时锁定；之后变化需显式允许重新锁定。 */
  criteria: CriteriaSet;
  /** 全文阶段的标准；缺省与题摘阶段相同。 */
  fulltextCriteria?: CriteriaSet;
  candidates: readonly CandidateRecord[];
  search?: SearchRecord | null;
  steps?: readonly RunnerStep[];
  /** 标准与已锁定版本不同时是否允许重新锁定并重评估。默认不允许，直接报错。 */
  allowCriteriaRelock?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: RunnerProgress) => void;
};

export type ReviewRunResult = {
  state: ReviewState;
  ledger: PrismaLedger;
  budget: BudgetUsage;
  /** 本轮成功筛完的条数（模型调用失败的不算），用于确认断点续跑只做了增量。 */
  screened: { abstract: number; fulltext: number };
};

export type HumanDecisionInput = {
  reviewId: string;
  pmid: string;
  decision: FinalDecision;
  reason: string;
  actor?: string;
};

export type MetaReviewRunnerOptions = {
  model: StructuredModelClient;
  /** 状态根目录；每篇评价一个子目录。 */
  stateRoot: string;
  fulltext?: FullTextSource | null;
  /** 排除决定的引用核不实时是否拒绝提交、转人工。默认开。实验矩阵的 B0 关掉它。 */
  evidenceGate?: boolean;
  concurrency?: number;
  /** 每处理多少条落一次盘。 */
  checkpointEvery?: number;
  audit?: AuditLog;
  now?: () => string;
};

export type MetaReviewRunner = {
  run(input: ReviewRunInput): Promise<ReviewRunResult>;
  /** 人工裁决：清掉人工队列标记，提交最终决定，计一次人工成本。 */
  applyHumanDecision(input: HumanDecisionInput): Promise<ReviewState>;
  load(reviewId: string): Promise<ReviewState | null>;
};

function sameCriteria(locked: LockedCriteria, next: CriteriaSet): boolean {
  if (locked.source !== next.source) return false;
  if (locked.keys.join(",") !== next.keys.join(",")) return false;
  return next.keys.every((key) => (locked.elements[key] ?? "") === (next.elements[key] ?? ""));
}

function toAccess(availability: FullTextAvailability): FullTextAccess {
  switch (availability.status) {
    case "available":
      return { status: "available", pmcid: availability.pmcid };
    case "no_pmc":
      return { status: "no_pmc" };
    case "no_body":
      return {
        status: "no_body",
        pmcid: availability.pmcid,
        scanned: availability.scanned,
        ...(availability.pdfUri ? { pdfUri: availability.pdfUri } : {}),
      };
    case "error":
      return { status: "error", error: availability.error };
  }
}

/**
 * 账本每次从 items 重新算，不做增量加减。
 * 断点续跑、人工改判、重新锁定标准都会改 items，增量计数很容易算漏或算重。
 */
export function computeLedger(items: Readonly<Record<string, ItemState>>): PrismaLedger {
  const ledger = emptyLedger();
  for (const item of Object.values(items)) {
    ledger.candidates += 1;
    if (item.abstractDecision) ledger.abstractScreened += 1;
    if (item.abstractDecision?.decision === "include") ledger.abstractKept += 1;
    const excludedAtAbstract = item.finalDecision === "exclude" && !item.fulltextDecision;
    if (excludedAtAbstract && item.decidedBy === "model") ledger.abstractExcludedByModel += 1;
    if (excludedAtAbstract && item.decidedBy === "human") ledger.abstractExcludedByHuman += 1;

    if (item.fullText.status !== "not_sought") ledger.fullTextSought += 1;
    if (item.fullText.status === "available") ledger.fullTextAvailable += 1;
    if (item.fullText.status === "no_pmc") ledger.fullTextUnavailable.noPmc += 1;
    if (item.fullText.status === "no_body") ledger.fullTextUnavailable.noBody += 1;
    if (item.fullText.status === "error") ledger.fullTextUnavailable.error += 1;

    if (item.finalDecision === "include") ledger.fullTextIncluded += 1;
    const excludedAtFullText = item.finalDecision === "exclude" && Boolean(item.fulltextDecision);
    if (excludedAtFullText && item.decidedBy === "model") ledger.fullTextExcludedByModel += 1;
    if (excludedAtFullText && item.decidedBy === "human") ledger.fullTextExcludedByHuman += 1;
    if (item.escalation && item.finalDecision === undefined) ledger.fullTextUnresolved += 1;
  }
  return ledger;
}

export function createMetaReviewRunner(options: MetaReviewRunnerOptions): MetaReviewRunner {
  const evidenceGate = options.evidenceGate !== false;
  const concurrency = options.concurrency ?? 4;
  const checkpointEvery = Math.max(1, options.checkpointEvery ?? 25);
  const now = options.now ?? (() => new Date().toISOString());

  function auditFor(reviewId: string): AuditLog {
    return options.audit ?? createAuditLog(options.stateRoot, reviewId);
  }

  function commit(item: ItemState, decision: FinalDecision, by: DecisionActor, round: number, at: string, why: string) {
    item.finalDecision = decision;
    item.decidedBy = by;
    item.stage = "committed";
    delete item.escalation;
    item.events.push({ at, round, kind: "committed", detail: `${decision} by ${by}: ${why}` });
  }

  function escalate(item: ItemState, reason: string, round: number, at: string) {
    item.escalation = { reason, round };
    item.events.push({ at, round, kind: "escalated", detail: reason });
  }

  function lockCriteria(state: ReviewState, criteria: CriteriaSet, allowRelock: boolean, at: string): SnapshotKind {
    if (!state.criteria) {
      state.criteria = {
        source: criteria.source,
        keys: [...criteria.keys],
        elements: { ...criteria.elements },
        lockedAt: at,
        criteriaVersion: 1,
      };
      return "pipeline_run";
    }
    if (sameCriteria(state.criteria, criteria)) return "pipeline_run";
    if (!allowRelock) {
      throw new Error(
        `criteria for ${state.reviewId} differ from locked version ${state.criteria.criteriaVersion}; `
        + "pass allowCriteriaRelock to re-lock and re-evaluate",
      );
    }
    const version = state.criteria.criteriaVersion + 1;
    state.criteria = {
      source: criteria.source,
      keys: [...criteria.keys],
      elements: { ...criteria.elements },
      lockedAt: at,
      criteriaVersion: version,
    };
    // 标准变了，模型做出的判断全部失效；人工提交的决定保留（RQ5 的保守策略）。
    for (const item of Object.values(state.items)) {
      if (item.decidedBy === "human") continue;
      item.stage = "candidate";
      delete item.abstractDecision;
      delete item.fulltextDecision;
      delete item.finalDecision;
      delete item.decidedBy;
      delete item.escalation;
      item.events.push({
        at,
        round: state.round,
        kind: "criteria_relocked",
        detail: `标准重新锁定为版本 ${version}，模型判断作废待重评；历史观察保留`,
      });
    }
    return "criteria_relock";
  }

  function ingest(state: ReviewState, candidates: readonly CandidateRecord[], round: number, at: string): number {
    let added = 0;
    for (const record of candidates) {
      if (state.items[record.pmid]) continue;
      state.items[record.pmid] = {
        pmid: record.pmid,
        title: record.title,
        stage: "candidate",
        criteria: {},
        fullText: { status: "not_sought" },
        events: [{ at, round, kind: "ingested", detail: "进入候选队列" }],
      };
      added += 1;
    }
    return added;
  }

  function applyAbstract(state: ReviewState, item: ItemState, prediction: ScreeningPrediction, round: number, at: string) {
    if (prediction.failed) {
      // 留在 candidate 阶段，下次重跑自动重试。不能记成排除，也不能记成已筛。
      item.events.push({ at, round, kind: "skipped", detail: `题摘筛选模型调用失败：${prediction.error ?? "unknown"}` });
      return;
    }
    for (const { key, observation } of observationsFromAbstract(prediction, round, at)) {
      item.criteria[key] = mergeObservation(key, item.criteria[key], observation);
    }
    item.abstractDecision = {
      decision: prediction.decision,
      confidence: prediction.confidence,
      reason: prediction.decisionReason,
      round,
    };
    item.stage = "abstract_screened";
    item.events.push({ at, round, kind: "abstract_screened", detail: `${prediction.decision}/${prediction.confidence}` });

    if (prediction.decision === "exclude") {
      const usable = prediction.evidenceVerified || prediction.evidenceFailure === "spliced";
      if (!evidenceGate || usable) {
        commit(item, "exclude", "model", round, at, prediction.decisionReason);
      } else {
        escalate(item, `题摘排除的引用无法在原文核实（${prediction.evidenceFailure ?? "unknown"}），转人工`, round, at);
      }
      return;
    }
    item.stage = "fulltext_pending";
  }

  function applyFullText(state: ReviewState, item: ItemState, prediction: FullTextPrediction, round: number, at: string) {
    if (prediction.failed) {
      item.events.push({ at, round, kind: "skipped", detail: `全文筛选模型调用失败：${prediction.error ?? "unknown"}` });
      return;
    }
    for (const { key, observation } of observationsFromFullText(prediction, round, at)) {
      item.criteria[key] = mergeObservation(key, item.criteria[key], observation);
    }
    item.fulltextDecision = {
      decision: prediction.decision,
      confidence: prediction.confidence,
      reason: prediction.decisionReason,
      round,
    };
    item.stage = "fulltext_screened";
    item.events.push({
      at,
      round,
      kind: "fulltext_screened",
      detail: `${prediction.decision}/${prediction.confidence}${prediction.truncated ? " (truncated)" : ""}`,
    });

    const usable = prediction.evidenceVerified || prediction.evidenceFailure === "spliced";
    if (prediction.decision === "include") {
      commit(item, "include", "model", round, at, prediction.decisionReason);
    } else if (prediction.decision === "exclude") {
      if (!evidenceGate || usable) {
        commit(item, "exclude", "model", round, at, prediction.decisionReason);
      } else {
        escalate(item, `全文排除的引用无法核实（${prediction.evidenceFailure ?? "unknown"}），转人工`, round, at);
      }
    } else {
      escalate(item, `全文阶段未决：${prediction.decisionReason}`, round, at);
    }
  }

  async function run(input: ReviewRunInput): Promise<ReviewRunResult> {
    const steps = input.steps ?? ["abstract", "fulltext"];
    const startedMs = Date.now();
    const audit = auditFor(input.reviewId);
    const at = now();

    const state = (await loadReviewState(options.stateRoot, input.reviewId))
      ?? initialReviewState(input.reviewId, at);
    state.round += 1;
    const round = state.round;
    const meter: BudgetMeter = createBudgetMeter(state.budget);
    const model = meter.meterModel(options.model);
    const screener = createScreenerStation(model);
    const fulltextScreener = createFullTextScreenerStation(model, { evidenceGate });

    let saving: Promise<unknown> = Promise.resolve();
    let current = state;
    const persist = (kind: SnapshotKind = "pipeline_run") => {
      saving = saving.then(async () => {
        current.ledger = computeLedger(current.items);
        current.budget = meter.snapshot();
        const saved = await saveReviewState(options.stateRoot, current, kind);
        current.version = saved.version;
        current.updatedAt = saved.updatedAt;
      });
      return saving;
    };

    const relock = lockCriteria(state, input.criteria, input.allowCriteriaRelock === true, at);
    if (input.search !== undefined) state.search = input.search;
    const added = ingest(state, input.candidates, round, at);
    await audit.record({
      reviewId: input.reviewId,
      round,
      step: "ingest",
      phase: "completed",
      detail: { added, total: Object.keys(state.items).length, criteriaVersion: state.criteria?.criteriaVersion },
    });
    await persist(relock);

    const screened = { abstract: 0, fulltext: 0 };

    if (steps.includes("abstract")) {
      const byPmid = new Map(input.candidates.map((record) => [record.pmid, record]));
      const pending = Object.values(state.items).filter((item) => item.stage === "candidate");
      await audit.record({ reviewId: input.reviewId, round, step: "abstract", phase: "started", detail: { pending: pending.length } });
      let done = 0;
      try {
        await mapWithConcurrency(pending, concurrency, async (item) => {
          const record = byPmid.get(item.pmid);
          const stamp = now();
          if (!record) {
            item.events.push({ at: stamp, round, kind: "skipped", detail: "本轮未提供该条的标题摘要" });
          } else {
            const prediction = await screener.screen({ record, criteria: input.criteria, signal: input.signal });
            applyAbstract(state, item, prediction, round, stamp);
            if (!prediction.failed) screened.abstract += 1;
          }
          done += 1;
          input.onProgress?.({ step: "abstract", done, total: pending.length });
          if (done % checkpointEvery === 0) await persist();
        });
        await audit.record({ reviewId: input.reviewId, round, step: "abstract", phase: "completed", detail: { screened: screened.abstract } });
      } catch (error) {
        await persist();
        await audit.record({
          reviewId: input.reviewId,
          round,
          step: "abstract",
          phase: "failed",
          detail: { error: error instanceof Error ? error.message : String(error), done },
        });
        throw error;
      }
      await persist();
    }

    if (steps.includes("fulltext")) {
      const criteria = input.fulltextCriteria ?? input.criteria;
      const pending = Object.values(state.items).filter(
        (item) => item.stage === "fulltext_pending" && !item.escalation,
      );
      await audit.record({ reviewId: input.reviewId, round, step: "fulltext", phase: "started", detail: { pending: pending.length } });
      if (!options.fulltext) {
        const stamp = now();
        for (const item of pending) {
          escalate(item, "未配置全文来源，转人工获取全文", round, stamp);
        }
        await audit.record({ reviewId: input.reviewId, round, step: "fulltext", phase: "skipped", detail: { reason: "no fulltext source" } });
      } else {
        const source = options.fulltext;
        let done = 0;
        try {
          const pmcMap = pending.length > 0
            ? await source.resolvePmcIds(pending.map((item) => item.pmid))
            : new Map<string, string>();
          if (pending.length > 0) meter.addPubMedRequests(1);
          await mapWithConcurrency(pending, concurrency, async (item) => {
            const availability = await source.get(item.pmid, pmcMap.get(item.pmid));
            meter.addFullTextFetches(1);
            const stamp = now();
            item.fullText = toAccess(availability);
            item.events.push({ at: stamp, round, kind: "fulltext_resolved", detail: availability.status });
            if (availability.status !== "available") {
              escalate(item, `全文不可得（${availability.status}），转人工`, round, stamp);
            } else {
              const prediction = await fulltextScreener.screen({ doc: availability.doc, criteria, signal: input.signal });
              applyFullText(state, item, prediction, round, now());
              if (!prediction.failed) screened.fulltext += 1;
            }
            done += 1;
            input.onProgress?.({ step: "fulltext", done, total: pending.length });
            if (done % checkpointEvery === 0) await persist();
          });
          await audit.record({ reviewId: input.reviewId, round, step: "fulltext", phase: "completed", detail: { screened: screened.fulltext } });
        } catch (error) {
          await persist();
          await audit.record({
            reviewId: input.reviewId,
            round,
            step: "fulltext",
            phase: "failed",
            detail: { error: error instanceof Error ? error.message : String(error), done },
          });
          throw error;
        }
      }
      await persist();
    }

    meter.addWallClock(Date.now() - startedMs);
    await persist();
    current = state;
    return {
      state,
      ledger: state.ledger,
      budget: state.budget,
      screened,
    };
  }

  async function applyHumanDecision(input: HumanDecisionInput): Promise<ReviewState> {
    const state = await loadReviewState(options.stateRoot, input.reviewId);
    if (!state) throw new Error(`no state for ${input.reviewId}`);
    const item = state.items[input.pmid];
    if (!item) throw new Error(`${input.pmid} is not a candidate of ${input.reviewId}`);
    const at = now();
    const meter = createBudgetMeter(state.budget);
    meter.addHumanQueries(1);
    const who = input.actor ? `human(${input.actor})` : "human";
    if (input.decision === "unresolved") {
      escalate(item, `人工标记为未决：${input.reason}`, state.round, at);
    } else {
      commit(item, input.decision, "human", state.round, at, `${who}: ${input.reason}`);
    }
    state.ledger = computeLedger(state.items);
    state.budget = meter.snapshot();
    const saved = await saveReviewState(options.stateRoot, state, "human_override");
    await auditFor(input.reviewId).record({
      reviewId: input.reviewId,
      round: state.round,
      step: "human_decision",
      phase: "completed",
      detail: { pmid: input.pmid, decision: input.decision, actor: input.actor ?? null },
    });
    return saved;
  }

  return {
    run,
    applyHumanDecision,
    load: (reviewId) => loadReviewState(options.stateRoot, reviewId),
  };
}

/** 给命令行与测试用的一行摘要。 */
export function summarizeLedger(ledger: PrismaLedger, budget: BudgetUsage): string {
  const unavailable = ledger.fullTextUnavailable;
  return [
    `candidates=${ledger.candidates}`,
    `abstract: screened=${ledger.abstractScreened} kept=${ledger.abstractKept} excluded=${ledger.abstractExcludedByModel}+${ledger.abstractExcludedByHuman}h`,
    `fulltext: sought=${ledger.fullTextSought} available=${ledger.fullTextAvailable} `
      + `unavailable=${unavailable.noPmc + unavailable.noBody + unavailable.error} `
      + `included=${ledger.fullTextIncluded} excluded=${ledger.fullTextExcludedByModel}+${ledger.fullTextExcludedByHuman}h unresolved=${ledger.fullTextUnresolved}`,
    `budget: calls=${budget.modelCalls} promptChars=${budget.promptChars} fetches=${budget.fullTextFetches} human=${budget.humanQueries} wall=${Math.round(budget.wallClockMs / 1000)}s`,
  ].join(" | ");
}
