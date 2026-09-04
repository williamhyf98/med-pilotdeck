import { randomUUID } from "node:crypto";

import type { TraumaAuditLogger, TraumaAuditRecord } from "./auditLog.js";
import { mergeExtractedFacts } from "./factMerge.js";
import { resolveGate } from "./gate.js";
import type { StructuredModelClient } from "./modelClient.js";
import { TRAUMA_RAG_TOP_K, type TraumaRagClient } from "./rag/client.js";
import { mergeRetrieval } from "./rag/merge.js";
import { buildBaselineQueries } from "./rag/queryPlan.js";
import { initialCaseState, isLaterSubStage, SUBSTAGE_TO_MAIN } from "./stageConfig.js";
import { createExtractorStation } from "./stations/extractor.js";
import { createPlannerStation } from "./stations/planner.js";
import { createReasonerStation } from "./stations/reasoner.js";
import type { TraumaCaseStore } from "./store.js";
import { computeTimeline } from "./timeline.js";
import type {
  AgentTurnResponse,
  CaseSnapshot,
  CaseState,
  ClassificationRecord,
  MainStage,
  SubStage,
} from "./types.js";

/** 一轮推演里对用户可见的阶段，用于在等待期间给出进度反馈。 */
export type TraumaTurnPhase = "extract" | "retrieve" | "reason";

export type TraumaTurnProgress =
  | { phase: TraumaTurnPhase; status: "started"; detail?: string }
  | { phase: TraumaTurnPhase; status: "finished"; ok: boolean; detail?: string };

export type TraumaTurnInput = {
  projectId: string;
  sessionId: string;
  messageId: string;
  userText: string;
  now: string;
  attachmentSummary?: string;
  onProgress?: (progress: TraumaTurnProgress) => void;
};

export type TransitionConfirmationInput = {
  sessionId: string;
  projectId: string;
  answer: "confirmed" | "declined";
  expectedVersion: number;
};

export type ManualStageOverrideInput = {
  sessionId: string;
  projectId: string;
  actorId: string;
  toStage: MainStage;
  toSubStage: SubStage;
  reason: string;
  riskAcknowledged: true;
  blockedOverrideConfirmed?: boolean;
};

export type TraumaTurnRunner = {
  runTurn(input: TraumaTurnInput): Promise<AgentTurnResponse>;
  confirmTransition(input: TransitionConfirmationInput): Promise<CaseSnapshot>;
  overrideStage(input: ManualStageOverrideInput): Promise<CaseSnapshot>;
};

const FIRST_CASE_GUIDE = "请提供伤员伤情、生命体征、已做处置或需要研判的问题，以便开始战伤分级救治推演。";
const CONTINUE_CASE_HINT = "请继续提供伤情变化、处置结果或需要研判的问题。";

function idleClassification(now: string): ClassificationRecord {
  return {
    version: 0,
    type: "emergency_triage",
    createdAt: now,
    severity: "unknown",
    treatmentPriority: "pending",
    transportPriority: "pending",
    rationale: [],
  };
}

function idleResponse(state: CaseState, message: string, now: string): AgentTurnResponse {
  return {
    messageId: "idle",
    caseVersion: state.version,
    round: state.round,
    naturalLanguageAnswer: message,
    stage: { main: state.currentStage, sub: state.currentSubStage },
    classification: idleClassification(now),
    treatmentPlan: [],
    missingInformation: [],
    timeline: state.timeline,
    transition: {
      status: "ASSESSING",
      reason: "not a case update",
      requiresUserConfirmation: false,
    },
    gateAssessment: {
      needHigherCapability: "unknown",
      requiredCapabilities: [],
      transportReadiness: "unknown",
      instabilityIndicators: [],
      blockingFactors: [],
      transportPrerequisites: [],
      ruleConflicts: [],
      confidence: 0,
      evidenceChunkIds: [],
    },
    memo: {
      round: state.round,
      mainStage: state.currentStage,
      subStage: state.currentSubStage,
      title: "未更新病例",
      inputPoints: [],
      actionPoints: [],
      conclusion: message.slice(0, 40),
    },
    evidence: [],
  };
}

export function createTraumaTurnRunner(deps: {
  store: TraumaCaseStore;
  model: StructuredModelClient;
  rag: TraumaRagClient;
  audit?: TraumaAuditLogger;
  now?: () => string;
}): TraumaTurnRunner {
  const extractor = createExtractorStation(deps.model);
  const planner = createPlannerStation(deps.model);
  const reasoner = createReasonerStation(deps.model);

  return {
    async runTurn(input) {
      const now = input.now ?? deps.now?.() ?? new Date().toISOString();
      const auditBase = {
        runId: input.messageId,
        projectId: input.projectId,
        sessionId: input.sessionId,
      };
      let activeStep: { number: number; phase: string; startedAt: number } | undefined;
      const recordAudit = async (
        entry: Omit<TraumaAuditRecord, "timestamp" | "runId" | "projectId" | "sessionId">,
      ) => {
        await deps.audit?.record({
          timestamp: deps.now?.() ?? new Date().toISOString(),
          ...auditBase,
          ...entry,
        });
      };
      const beginStep = async (number: number, phase: string) => {
        activeStep = { number, phase, startedAt: Date.now() };
        await recordAudit({
          level: "INFO",
          event: "step_started",
          step: number,
          phase,
          status: "started",
        });
      };
      const completeStep = async (details?: Record<string, unknown>) => {
        if (!activeStep) return;
        await recordAudit({
          level: "INFO",
          event: "step_completed",
          step: activeStep.number,
          phase: activeStep.phase,
          status: "ok",
          durationMs: Date.now() - activeStep.startedAt,
          details,
        });
        activeStep = undefined;
      };

      await recordAudit({
        level: "INFO",
        event: "turn_started",
        status: "started",
        details: {
          inputCharacters: input.userText.length,
          hasAttachments: Boolean(input.attachmentSummary),
        },
      });

      const report = input.onProgress ?? (() => {});
      try {
        await beginStep(1, "load_case_state");
        const previous = await deps.store.load() ?? initialCaseState({
          projectId: input.projectId,
          sessionId: input.sessionId,
          now,
        });
        await completeStep({ version: previous.version, round: previous.round });

        await beginStep(2, "extract_facts");
        report({ phase: "extract", status: "started" });
        let facts;
        facts = await extractor.extract({
          userText: input.userText,
          previous,
          attachmentSummary: input.attachmentSummary,
        });
        report({
          phase: "extract",
          status: "finished",
          ok: true,
          detail: `turnKind=${facts.turnKind}`,
        });
        await completeStep({
          turnKind: facts.turnKind,
          vitalCount: facts.vitalSigns.length,
          injuryCount: facts.injuryFindings.length,
          treatmentCount: facts.treatmentEvents.length,
          careTransportCount: facts.careAndTransportFacts.length,
        });

        await beginStep(3, "classify_turn");
        if (facts.turnKind === "no_case_update") {
          await completeStep({ fullPipeline: false });
          const isFirstEmpty = previous.round === 0 && previous.injuries.length === 0 && previous.vitalSignsHistory.length === 0;
          const response = idleResponse(previous, isFirstEmpty ? FIRST_CASE_GUIDE : CONTINUE_CASE_HINT, now);
          await recordAudit({
            level: "INFO",
            event: "turn_completed",
            status: "ok",
            details: { fullPipeline: false, version: previous.version, round: previous.round },
          });
          return response;
        }
        await completeStep({ fullPipeline: true });

        await beginStep(4, "merge_candidate_state");
      const candidate = mergeExtractedFacts(previous, facts, now);
        await completeStep({
          injuryCount: candidate.injuries.length,
          vitalHistoryCount: candidate.vitalSignsHistory.length,
        });

        await beginStep(5, "lock_current_stage");
        // 阶段与机构只读取既有 Case State；模型不得在本步骤自行升级。
        candidate.currentStage = previous.currentStage;
        candidate.currentSubStage = previous.currentSubStage;
        candidate.currentFacility = previous.currentFacility;
        await completeStep({
          currentStage: candidate.currentStage,
          currentSubStage: candidate.currentSubStage,
        });

        await beginStep(6, "compute_timeline");
      const timeline = computeTimeline({
        injuryTime: candidate.timeline.injuryTime,
        now,
        currentSubStage: candidate.currentSubStage,
      });
      candidate.timeline = timeline;
        await completeStep({
          elapsedMinutes: timeline.elapsedMinutes,
          timingStatus: timeline.timingStatus,
        });

        await beginStep(7, "baseline_retrieval");
      report({ phase: "retrieve", status: "started" });
      const baseline = buildBaselineQueries(candidate);
      const firstWaveResults = await Promise.all(baseline.map(async (query) => {
        const result = await deps.rag.query({ query: query.query, top_k: TRAUMA_RAG_TOP_K });
        return { query, chunks: result.chunks, backend: result.retrieval_backend };
      }));
      const firstWave = mergeRetrieval({ queries: baseline, results: firstWaveResults }).retrieval;
        await completeStep({
          queryCount: baseline.length,
          chunkCount: firstWave.allChunkIds.length,
          coverageGapCount: firstWave.criticalCoverageGaps.length,
        });

        await beginStep(8, "plan_supplemental_queries");
      const supplemental = await planner.plan({
        state: candidate,
        firstWave,
        remainingBudget: Math.max(0, 6 - baseline.length),
      });
        await completeStep({ plannedQueryCount: supplemental.length });

        await beginStep(9, "supplemental_retrieval");
      const secondWaveResults = supplemental.length === 0
        ? []
        : await Promise.all(supplemental.map(async (query) => {
          const result = await deps.rag.query({ query: query.query, top_k: TRAUMA_RAG_TOP_K });
          return { query, chunks: result.chunks, backend: result.retrieval_backend };
        }));
        await completeStep({
          skipped: supplemental.length === 0,
          queryCount: supplemental.length,
          chunkCount: secondWaveResults.reduce((sum, result) => sum + result.chunks.length, 0),
        });

        await beginStep(10, "merge_retrieval");
      const merged = mergeRetrieval({
        queries: [...baseline, ...supplemental],
        results: [...firstWaveResults, ...secondWaveResults],
      });
      report({
        phase: "retrieve",
        status: "finished",
        ok: true,
        detail: `检索 ${merged.retrieval.totalCalls} 次，选用 ${merged.promptChunks.length} 个知识块`,
      });
        await completeStep({
          totalCalls: merged.retrieval.totalCalls,
          allChunkCount: merged.retrieval.allChunkIds.length,
          promptChunkCount: merged.promptChunks.length,
          coverageGapCount: merged.retrieval.criticalCoverageGaps.length,
        });

        await beginStep(11, "reason");
      report({ phase: "reason", status: "started" });
        const reasoned = await reasoner.reason({
          state: candidate,
          timeline,
          promptChunks: merged.promptChunks,
        });
      report({ phase: "reason", status: "finished", ok: true });
        await completeStep({
          treatmentActionCount: reasoned.treatmentPlan.length,
          missingInformationCount: reasoned.missingInformation.length,
          modelTransitionStatus: reasoned.transition.status,
        });

        await beginStep(12, "resolve_gate");
      const gateStatus = resolveGate(reasoned.gateAssessment, merged.retrieval);
      const requiresUserConfirmation = gateStatus === "READY";
        await completeStep({
          gateStatus,
          confidence: reasoned.gateAssessment.confidence,
          requiresUserConfirmation,
        });

        await beginStep(13, "prepare_transition");
      const pendingTransition = gateStatus === "READY" && reasoned.transition.targetStage && reasoned.transition.targetSubStage
        ? {
          askedAt: now,
          targetStage: reasoned.transition.targetStage,
          targetSubStage: reasoned.transition.targetSubStage,
          reason: reasoned.transition.reason,
        }
        : undefined;
        await completeStep({
          pendingTransition: Boolean(pendingTransition),
          targetStage: pendingTransition?.targetStage,
          targetSubStage: pendingTransition?.targetSubStage,
        });

        await beginStep(14, "mark_evidence");
      const cited = new Set([
        ...reasoned.treatmentPlan.flatMap((action) => action.evidenceChunkIds),
        ...reasoned.gateAssessment.evidenceChunkIds,
      ]);
      const evidence = merged.evidence.map((chunk) => ({
        ...chunk,
        usedInAnswer: cited.has(chunk.id),
      }));
        await completeStep({
          evidenceCount: evidence.length,
          citedEvidenceCount: cited.size,
        });

        await beginStep(15, "build_response_and_snapshot");
      const round = previous.round + 1;
      const version = previous.version + 1;
      const memo = {
        ...reasoned.memo,
        id: randomUUID(),
        round,
        createdAt: now,
        mainStage: candidate.currentStage,
        subStage: candidate.currentSubStage,
        snapshotVersion: version,
      };

      const next: CaseState = {
        ...candidate,
        version,
        round,
        updatedAt: now,
        currentStage: previous.currentStage,
        currentSubStage: previous.currentSubStage,
        currentFacility: previous.currentFacility,
        currentCapabilities: candidate.currentCapabilities.length > 0
          ? candidate.currentCapabilities
          : previous.currentCapabilities,
        currentActions: reasoned.treatmentPlan.filter((action) => action.scope === "current_stage"),
        classificationHistory: [...candidate.classificationHistory, reasoned.classification],
        transport: {
          ...candidate.transport,
          needed: gateStatus === "READY" || gateStatus === "BLOCKED",
          gateStatus,
          readiness: reasoned.gateAssessment.transportReadiness,
          medicalTargetLevel: reasoned.transition.targetSubStage ?? reasoned.transition.targetStage,
          confirmation: pendingTransition,
        },
        pendingTransition,
        timeline,
        evidence,
        memos: [...candidate.memos, memo],
        missingInformation: reasoned.missingInformation,
      };

      const response: AgentTurnResponse = {
        messageId: input.messageId,
        caseVersion: version,
        round,
        naturalLanguageAnswer: reasoned.naturalLanguageAnswer,
        stage: { main: next.currentStage, sub: next.currentSubStage },
        classification: reasoned.classification,
        treatmentPlan: reasoned.treatmentPlan,
        missingInformation: reasoned.missingInformation,
        timeline,
        transition: {
          status: gateStatus,
          targetStage: reasoned.transition.targetStage,
          targetSubStage: reasoned.transition.targetSubStage,
          reason: reasoned.transition.reason,
          requiresUserConfirmation,
        },
        gateAssessment: reasoned.gateAssessment,
        memo,
        evidence,
      };
        await completeStep({ version, round, memoId: memo.id });

        await beginStep(16, "persist_snapshot");
      await deps.store.saveTurn(next, {
        eventType: "agent_turn",
        round,
        createdAt: now,
        triggerMessageId: input.messageId,
        state: next,
        retrieval: merged.retrieval,
        response,
      });
        await completeStep({ version, round, snapshotEventType: "agent_turn" });

        await recordAudit({
          level: "INFO",
          event: "turn_completed",
          status: "ok",
          details: { version, round, gateStatus },
        });
      return response;
      } catch (error) {
        if (activeStep) {
          await recordAudit({
            level: "ERROR",
            event: "step_failed",
            step: activeStep.number,
            phase: activeStep.phase,
            status: "error",
            durationMs: Date.now() - activeStep.startedAt,
            error,
          });
        }
        report({
          phase: activeStep?.phase === "extract_facts"
            ? "extract"
            : activeStep?.phase === "reason" ? "reason" : "retrieve",
          status: "finished",
          ok: false,
          detail: String(error),
        });
        await recordAudit({
          level: "ERROR",
          event: "turn_failed",
          status: "error",
          details: {
            failedStep: activeStep?.number,
            failedPhase: activeStep?.phase,
          },
          error,
        });
        throw error;
      }
    },

    async confirmTransition(input) {
      const current = await deps.store.load();
      if (!current) {
        throw new Error("no case state to confirm");
      }
      if (!current.pendingTransition) {
        throw new Error("no pending transition");
      }
      if (input.expectedVersion !== current.version) {
        throw new Error("stale confirmation version");
      }
      const now = deps.now?.() ?? new Date().toISOString();
      const confirmed = input.answer === "confirmed";
      const next: CaseState = {
        ...current,
        version: current.version + 1,
        updatedAt: now,
        currentStage: confirmed ? current.pendingTransition.targetStage : current.currentStage,
        currentSubStage: confirmed ? current.pendingTransition.targetSubStage : current.currentSubStage,
        pendingTransition: undefined,
        transport: {
          ...current.transport,
          gateStatus: confirmed ? "COMPLETED" : current.transport.gateStatus === "READY" ? "STAY" : current.transport.gateStatus,
          confirmation: {
            ...current.pendingTransition,
            answeredAt: now,
            answer: input.answer,
          },
        },
      };
      const snapshot: CaseSnapshot = {
        eventType: "transition_confirmation",
        round: next.round,
        createdAt: now,
        triggerMessageId: `confirmation:${input.answer}`,
        state: next,
      };
      await deps.store.saveTurn(next, snapshot);
      return snapshot;
    },

    async overrideStage(input) {
      const current = await deps.store.load();
      if (!current) {
        throw new Error("no case state to override");
      }
      if (SUBSTAGE_TO_MAIN[input.toSubStage] !== input.toStage) {
        throw new Error("stage mapping mismatch");
      }
      if (!isLaterSubStage(current.currentSubStage, input.toSubStage)) {
        throw new Error("cannot override to an earlier or current substage");
      }
      if (current.transport.gateStatus === "BLOCKED" && input.blockedOverrideConfirmed !== true) {
        throw new Error("blocked override requires secondary confirmation");
      }
      const now = deps.now?.() ?? new Date().toISOString();
      const unresolvedRisks = [
        ...current.transport.blockingReason ? [current.transport.blockingReason] : [],
        ...current.missingInformation,
      ];
      const override = {
        id: randomUUID(),
        actorId: input.actorId,
        createdAt: now,
        fromStage: current.currentStage,
        fromSubStage: current.currentSubStage,
        toStage: input.toStage,
        toSubStage: input.toSubStage,
        reason: input.reason,
        originalGateStatus: current.transport.gateStatus,
        unresolvedRisks,
        riskAcknowledged: true as const,
        blockedOverrideConfirmed: input.blockedOverrideConfirmed === true,
      };
      const next: CaseState = {
        ...current,
        version: current.version + 1,
        updatedAt: now,
        currentStage: input.toStage,
        currentSubStage: input.toSubStage,
        currentFacility: current.currentFacility,
        currentCapabilities: current.currentCapabilities,
        pendingTransition: undefined,
        manualStageOverrides: [...current.manualStageOverrides, override],
        transport: {
          ...current.transport,
          gateStatus: "COMPLETED",
        },
      };
      const snapshot: CaseSnapshot = {
        eventType: "manual_stage_override",
        round: next.round,
        createdAt: now,
        triggerMessageId: override.id,
        state: next,
      };
      await deps.store.saveTurn(next, snapshot);
      return snapshot;
    },
  };
}
