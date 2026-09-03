import { randomUUID } from "node:crypto";

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

export type TraumaTurnInput = {
  projectId: string;
  sessionId: string;
  messageId: string;
  userText: string;
  now: string;
  attachmentSummary?: string;
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
  now?: () => string;
}): TraumaTurnRunner {
  const extractor = createExtractorStation(deps.model);
  const planner = createPlannerStation(deps.model);
  const reasoner = createReasonerStation(deps.model);

  return {
    async runTurn(input) {
      const now = input.now ?? deps.now?.() ?? new Date().toISOString();
      const previous = await deps.store.load() ?? initialCaseState({
        projectId: input.projectId,
        sessionId: input.sessionId,
        now,
      });

      const facts = await extractor.extract({
        userText: input.userText,
        previous,
        attachmentSummary: input.attachmentSummary,
      });

      if (facts.turnKind === "no_case_update") {
        const isFirstEmpty = previous.round === 0 && previous.injuries.length === 0 && previous.vitalSignsHistory.length === 0;
        return idleResponse(previous, isFirstEmpty ? FIRST_CASE_GUIDE : CONTINUE_CASE_HINT, now);
      }

      const candidate = mergeExtractedFacts(previous, facts, now);
      const timeline = computeTimeline({
        injuryTime: candidate.timeline.injuryTime,
        now,
        currentSubStage: candidate.currentSubStage,
      });
      candidate.timeline = timeline;

      const baseline = buildBaselineQueries(candidate);
      const firstWaveResults = await Promise.all(baseline.map(async (query) => {
        const result = await deps.rag.query({ query: query.query, top_k: TRAUMA_RAG_TOP_K });
        return { query, chunks: result.chunks, backend: result.retrieval_backend };
      }));
      const firstWave = mergeRetrieval({ queries: baseline, results: firstWaveResults }).retrieval;
      const supplemental = await planner.plan({
        state: candidate,
        firstWave,
        remainingBudget: Math.max(0, 6 - baseline.length),
      });
      const secondWaveResults = supplemental.length === 0
        ? []
        : await Promise.all(supplemental.map(async (query) => {
          const result = await deps.rag.query({ query: query.query, top_k: TRAUMA_RAG_TOP_K });
          return { query, chunks: result.chunks, backend: result.retrieval_backend };
        }));
      const merged = mergeRetrieval({
        queries: [...baseline, ...supplemental],
        results: [...firstWaveResults, ...secondWaveResults],
      });

      const reasoned = await reasoner.reason({
        state: candidate,
        timeline,
        promptChunks: merged.promptChunks,
      });
      const gateStatus = resolveGate(reasoned.gateAssessment, merged.retrieval);
      const requiresUserConfirmation = gateStatus === "READY";
      const pendingTransition = gateStatus === "READY" && reasoned.transition.targetStage && reasoned.transition.targetSubStage
        ? {
          askedAt: now,
          targetStage: reasoned.transition.targetStage,
          targetSubStage: reasoned.transition.targetSubStage,
          reason: reasoned.transition.reason,
        }
        : undefined;

      const cited = new Set([
        ...reasoned.treatmentPlan.flatMap((action) => action.evidenceChunkIds),
        ...reasoned.gateAssessment.evidenceChunkIds,
      ]);
      const evidence = merged.evidence.map((chunk) => ({
        ...chunk,
        usedInAnswer: cited.has(chunk.id),
      }));

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

      await deps.store.saveTurn(next, {
        eventType: "agent_turn",
        round,
        createdAt: now,
        triggerMessageId: input.messageId,
        state: next,
        retrieval: merged.retrieval,
        response,
      });

      return response;
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
