import { randomUUID } from "node:crypto";

import type { TraumaAuditLogger, TraumaAuditRecord } from "./auditLog.js";
import { mergeFormInput, validateTurnFormInput } from "./factMerge.js";
import { normalizeChineseDisplayText } from "./displayLabels.js";
import { resolveGate } from "./gate.js";
import { resolveStagePlacement } from "./placement.js";
import type { StructuredModelClient } from "./modelClient.js";
import { TRAUMA_RAG_TOPIC, TRAUMA_RAG_TOP_K, type TraumaRagClient } from "./rag/client.js";
import { mergeRetrieval } from "./rag/merge.js";
import { buildBaselineQueries } from "./rag/queryPlan.js";
import { initialCaseState, isLaterSubStage, SUBSTAGE_TO_MAIN, typicalFacilityForSubStage } from "./stageConfig.js";
import { createPlacementStation } from "./stations/placer.js";
import { createReasonerStation } from "./stations/reasoner.js";
import type { TraumaCaseStore } from "./store.js";
import type {
  AgentTurnResponse,
  CaseSnapshot,
  CaseState,
  MainStage,
  PlacementAssessment,
  SubStage,
  TurnFormInput,
} from "./types.js";

/** 一轮推演里对用户可见的阶段，用于在等待期间给出进度反馈。 */
export type TraumaTurnPhase = "validate" | "place" | "retrieve" | "reason";

export type TraumaTurnProgress =
  | { phase: TraumaTurnPhase; status: "started"; detail?: string }
  | { phase: TraumaTurnPhase; status: "finished"; ok: boolean; detail?: string }
  | {
      kind: "runner_step";
      step: number;
      phase: string;
      status: "started";
      title?: string;
      detail?: string;
    }
  | {
      kind: "runner_step";
      step: number;
      phase: string;
      status: "finished";
      ok: boolean;
      title?: string;
      detail?: string;
      durationMs?: number;
      details?: Record<string, unknown>;
    };

export type TraumaTurnInput = {
  projectId: string;
  sessionId: string;
  messageId: string;
  form: TurnFormInput;
  /** 用户本轮原始自由文本，存入快照供审计与回溯，不参与推演逻辑。 */
  rawInput?: string;
  now: string;
  onProgress?: (progress: TraumaTurnProgress) => void;
  onAssistantTextDelta?: (text: string) => void | Promise<void>;
  onAssistantTextEnd?: () => void | Promise<void>;
  requestPlacementConfirmation?: (
    request: PlacementConfirmationRequest,
  ) => Promise<PlacementConfirmationDecision>;
};

export type PlacementConfirmationRequest = {
  current: {
    stage: MainStage | null;
    subStage: SubStage | null;
    facilityName: string | null;
  };
  proposed: PlacementAssessment;
};

export type PlacementConfirmationDecision =
  | { choice: "proposed" }
  | { choice: "current" }
  | { choice: "selected"; stage: MainStage; subStage: SubStage };

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

function placementOnlyResponse(
  state: CaseState,
  placement: PlacementAssessment,
  messageId: string,
  message: string,
  now: string,
): AgentTurnResponse {
  return {
    messageId,
    caseVersion: state.version,
    round: state.round,
    naturalLanguageAnswer: message,
    stage: { main: state.currentStage, sub: state.currentSubStage },
    classification: {
      version: state.version,
      type: "emergency_triage",
      createdAt: now,
      severity: "unknown",
      treatmentPriority: "pending",
      transportPriority: "pending",
      rationale: [],
    },
    treatmentPlan: [],
    missingInformation: [],
    transition: { status: "ASSESSING", reason: placement.rationale, requiresUserConfirmation: false },
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
    placement,
    memo: {
      round: state.round,
      mainStage: state.currentStage,
      subStage: state.currentSubStage,
      title: "级别待确认",
      inputPoints: [],
      actionPoints: [],
      conclusion: message.slice(0, 40),
    },
    evidence: [],
  };
}

function summarizeRagHit(hit: { chunk_id: string; score: number; retrieval_backend: "remote" | "local" }): {
  chunkId: string;
  score: number;
  backend: "remote" | "local";
} {
  return {
    chunkId: hit.chunk_id,
    score: hit.score,
    backend: hit.retrieval_backend,
  };
}

export function createTraumaTurnRunner(deps: {
  store: TraumaCaseStore;
  model: StructuredModelClient;
  rag: TraumaRagClient;
  audit?: TraumaAuditLogger;
  now?: () => string;
}): TraumaTurnRunner {
  const placer = createPlacementStation(deps.model);
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
      const report = input.onProgress ?? (() => {});
      const beginStep = async (number: number, phase: string) => {
        activeStep = { number, phase, startedAt: Date.now() };
        report({ kind: "runner_step", step: number, phase, status: "started" });
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
        const durationMs = Date.now() - activeStep.startedAt;
        report({
          kind: "runner_step",
          step: activeStep.number,
          phase: activeStep.phase,
          status: "finished",
          ok: true,
          durationMs,
          details,
        });
        await recordAudit({
          level: "INFO",
          event: "step_completed",
          step: activeStep.number,
          phase: activeStep.phase,
          status: "ok",
          durationMs,
          details,
        });
        activeStep = undefined;
      };

      await recordAudit({
        level: "INFO",
        event: "turn_started",
        status: "started",
        details: {
          narrativeCharacters: input.form.injuryNarrative.length
            + input.form.treatmentNarrative.length
            + input.form.evacuationNarrative.length
            + input.form.note.length,
          measuredVitalCount: Object.keys(input.form.vitals).length,
        },
      });

      try {
        await beginStep(1, "load_case_state");
        const previous = await deps.store.load() ?? initialCaseState({
          projectId: input.projectId,
          sessionId: input.sessionId,
          now,
        });
        await completeStep({ version: previous.version, round: previous.round });

        await beginStep(2, "validate_and_merge_form");
        if (!validateTurnFormInput(input.form)) {
          throw new Error("invalid trauma form input");
        }
        const submittedForm = structuredClone(input.form);
        const nextRound = previous.round + 1;
        const candidate = mergeFormInput(previous, submittedForm, nextRound, now);
        candidate.round = nextRound;
        await completeStep({
          narrativeCount: candidate.injuryNarratives.length
            + candidate.treatmentNarratives.length
            + candidate.evacuationNarratives.length
            + candidate.notes.length,
          vitalHistoryCount: candidate.vitalSignsHistory.length,
        });

        await beginStep(3, "assess_placement");
        const proposedPlacement: PlacementAssessment = input.form.statedSubStage
          ? {
            determined: true,
            source: "user_stated",
            stage: SUBSTAGE_TO_MAIN[input.form.statedSubStage],
            subStage: input.form.statedSubStage,
            rationale: "用户通过表单明示本轮救治级别。",
            definitionReferences: [],
          }
          : await placer.place({ state: candidate });
        await completeStep({
          determined: proposedPlacement.determined,
          source: proposedPlacement.source,
          proposedStage: proposedPlacement.stage,
          proposedSubStage: proposedPlacement.subStage,
        });

        await beginStep(4, "confirm_placement");
        const placementChanged = proposedPlacement.determined && (
          proposedPlacement.stage !== previous.currentStage
          || proposedPlacement.subStage !== previous.currentSubStage
        );
        let selectedPlacement = proposedPlacement;
        // A level explicitly selected in the form is already the user's
        // confirmation for this round. Only model-determined changes need
        // an elicitation step before continuing the pipeline.
        if (placementChanged && !input.form.statedSubStage) {
          if (!input.requestPlacementConfirmation) {
            throw new Error("placement confirmation is required");
          }
          const decision = await input.requestPlacementConfirmation({
            current: {
              stage: previous.currentStage,
              subStage: previous.currentSubStage,
              facilityName: previous.currentFacility?.name ?? null,
            },
            proposed: proposedPlacement,
          });
          if (decision.choice === "current") {
            selectedPlacement = {
              determined: previous.currentStage !== null && previous.currentSubStage !== null,
              source: "user_stated",
              stage: previous.currentStage,
              subStage: previous.currentSubStage,
              rationale: "用户选择保持当前推演级别。",
              definitionReferences: [],
            };
          } else if (decision.choice === "selected") {
            selectedPlacement = {
              determined: true,
              source: "user_stated",
              stage: decision.stage,
              subStage: decision.subStage,
              rationale: "用户选择其他级别作为本轮推演基线。",
              definitionReferences: [],
            };
          }
        } else if (
          proposedPlacement.source === "undetermined"
          && previous.currentStage
          && previous.currentSubStage
        ) {
          selectedPlacement = {
            determined: true,
            source: "user_stated",
            stage: previous.currentStage,
            subStage: previous.currentSubStage,
            rationale: "本轮信息不足以改判，保持当前推演级别。",
            definitionReferences: [],
          };
        }

        const placed = resolveStagePlacement({ placement: selectedPlacement });
        candidate.currentStage = placed.stage;
        candidate.currentSubStage = placed.subStage;
        candidate.currentFacility = placed.facility;
        candidate.currentCapabilities = placed.facility?.capabilities ?? [];
        candidate.placementRationale = placed.rationale || undefined;
        candidate.placementEvidenceChunkIds = [];
        await completeStep({
          placementChanged,
          selectedStage: candidate.currentStage,
          selectedSubStage: candidate.currentSubStage,
        });

        if (!candidate.currentStage || !candidate.currentSubStage) {
          const outOfScope = proposedPlacement.source === "out_of_scope";
          await beginStep(5, "build_partial_response_and_snapshot");
          const partialState: CaseState = {
            ...candidate,
            version: previous.version + 1,
            round: nextRound,
            updatedAt: now,
          };
          const response = placementOnlyResponse(
            partialState,
            proposedPlacement,
            input.messageId,
            outOfScope
              ? `${proposedPlacement.rationale || "当前情况超出本系统支持范围。"} 本系统仅提供战现场急救（Ⅰ级）和早期救治（Ⅱ级）的操作意见，不提供专科治疗（Ⅲ级）或康复治疗（Ⅳ级）的具体处置措施。`
              : `目前信息不足以确定本轮推演所采用的主级和子级：${proposedPlacement.rationale || "请补充伤情、生命体征或当前救治位置。"} `,
            now,
          );
          await completeStep({
            version: partialState.version,
            round: partialState.round,
            placement: proposedPlacement.source,
          });

          await beginStep(6, "persist_partial_snapshot");
          await deps.store.saveTurn(partialState, {
            eventType: "agent_turn",
            round: partialState.round,
            createdAt: now,
            triggerMessageId: input.messageId,
            state: partialState,
            form: structuredClone(submittedForm),
            rawInput: input.rawInput,
            response,
          });
          await completeStep({
            version: partialState.version,
            round: partialState.round,
            snapshotEventType: "agent_turn",
          });
          await recordAudit({
            level: "INFO",
            event: "turn_completed",
            status: "ok",
            details: {
              fullPipeline: false,
              placement: proposedPlacement.source,
              version: partialState.version,
              round: partialState.round,
            },
          });
          return response;
        }

        await beginStep(5, "baseline_retrieval");
        const baseline = buildBaselineQueries(candidate);
        const firstWaveResults = await Promise.all(baseline.map(async (query) => {
          const result = await deps.rag.query({ query: query.query, top_k: TRAUMA_RAG_TOP_K, topic: TRAUMA_RAG_TOPIC });
          return { query, chunks: result.chunks, backend: result.retrieval_backend };
        }));
        const merged = mergeRetrieval({
          queries: baseline,
          results: firstWaveResults,
        });
        await completeStep({
          queries: merged.retrieval.queries.map((item, index) => ({
            index: index + 1,
            kind: item.kind,
            critical: item.critical,
            reason: item.reason,
            query: item.query,
            chunkCount: item.chunkIds.length,
            chunkIds: item.chunkIds,
            chunks: firstWaveResults[index]?.chunks.map(summarizeRagHit) ?? [],
            backend: firstWaveResults[index]?.backend ?? "local",
          })),
          queryCount: baseline.length,
          totalCalls: merged.retrieval.totalCalls,
          allChunkCount: merged.retrieval.allChunkIds.length,
          promptChunkCount: merged.promptChunks.length,
          coverageGapCount: merged.retrieval.criticalCoverageGaps.length,
        });

        await beginStep(6, "merge_retrieval");
        await completeStep({
          totalCalls: merged.retrieval.totalCalls,
          allChunkCount: merged.retrieval.allChunkIds.length,
          promptChunkCount: merged.promptChunks.length,
          coverageGapCount: merged.retrieval.criticalCoverageGaps.length,
        });

        await beginStep(7, "reason");
        const reasoned = await reasoner.reason({
          state: candidate,
          promptChunks: merged.promptChunks,
          onNaturalLanguageDelta: input.onAssistantTextDelta,
          onNaturalLanguageEnd: input.onAssistantTextEnd,
        });
        await completeStep({
          treatmentActionCount: reasoned.treatmentPlan.length,
          missingInformationCount: reasoned.missingInformation.length,
          modelTransitionStatus: reasoned.transition.status,
          placement: selectedPlacement.subStage,
        });

        await beginStep(8, "resolve_gate");
        const gateStatus = resolveGate(reasoned.gateAssessment, merged.retrieval);
        const requiresUserConfirmation = false;
        await completeStep({
          gateStatus,
          confidence: reasoned.gateAssessment.confidence,
          requiresUserConfirmation,
        });

        await beginStep(9, "mark_evidence");
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

        await beginStep(10, "build_response_and_snapshot");
        const round = nextRound;
        const version = previous.version + 1;
        const memo = {
          ...reasoned.memo,
          id: randomUUID(),
          round,
          createdAt: now,
          mainStage: candidate.currentStage,
          subStage: candidate.currentSubStage,
          title: normalizeChineseDisplayText(reasoned.memo.title),
          inputPoints: reasoned.memo.inputPoints.map((item) => normalizeChineseDisplayText(item)),
          actionPoints: reasoned.memo.actionPoints.map((item) => normalizeChineseDisplayText(item)),
          conclusion: normalizeChineseDisplayText(reasoned.memo.conclusion),
          snapshotVersion: version,
        };

        const next: CaseState = {
          ...candidate,
          version,
          round,
          updatedAt: now,
          currentStage: candidate.currentStage,
          currentSubStage: candidate.currentSubStage,
          currentFacility: candidate.currentFacility,
          currentCapabilities: candidate.currentCapabilities,
          classificationHistory: [...candidate.classificationHistory, reasoned.classification],
          requiredCapabilities: [...reasoned.gateAssessment.requiredCapabilities],
          transport: {
            ...candidate.transport,
            needed: gateStatus === "READY" || gateStatus === "BLOCKED",
            gateStatus,
            readiness: reasoned.gateAssessment.transportReadiness,
            medicalTargetLevel: reasoned.transition.targetSubStage ?? reasoned.transition.targetStage,
            targetFacilityType: reasoned.transition.targetSubStage
              ? typicalFacilityForSubStage(reasoned.transition.targetSubStage).name
              : undefined,
            blockingReason: reasoned.gateAssessment.blockingFactors.join("；") || undefined,
            // READY 只是后送的医学建议，本轮不生成待确认事项（见 reasonerPrompt 的说明）。
            confirmation: undefined,
          },
          pendingTransition: undefined,
          evidence,
          memos: [...candidate.memos, memo],
          missingInformation: reasoned.missingInformation,
        };

        const response: AgentTurnResponse = {
          messageId: input.messageId,
          caseVersion: version,
          round,
          naturalLanguageAnswer: normalizeChineseDisplayText(reasoned.naturalLanguageAnswer),
          stage: { main: next.currentStage, sub: next.currentSubStage },
          classification: reasoned.classification,
          treatmentPlan: reasoned.treatmentPlan.map((item) => ({
            ...item,
            title: normalizeChineseDisplayText(item.title),
            description: normalizeChineseDisplayText(item.description),
          })),
          missingInformation: reasoned.missingInformation.map((item) => normalizeChineseDisplayText(item)),
          transition: {
            status: gateStatus,
            targetStage: reasoned.transition.targetStage,
            targetSubStage: reasoned.transition.targetSubStage,
            reason: normalizeChineseDisplayText(reasoned.transition.reason),
            requiresUserConfirmation,
          },
          gateAssessment: reasoned.gateAssessment,
          placement: selectedPlacement,
          memo,
          evidence,
        };
        await completeStep({ version, round, memoId: memo.id });

        await beginStep(11, "persist_snapshot");
        await deps.store.saveTurn(next, {
          eventType: "agent_turn",
          round,
          createdAt: now,
          triggerMessageId: input.messageId,
          state: next,
          form: structuredClone(submittedForm),
          rawInput: input.rawInput,
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
          const durationMs = Date.now() - activeStep.startedAt;
          report({
            kind: "runner_step",
            step: activeStep.number,
            phase: activeStep.phase,
            status: "finished",
            ok: false,
            durationMs,
            detail: String(error),
          });
          await recordAudit({
            level: "ERROR",
            event: "step_failed",
            step: activeStep.number,
            phase: activeStep.phase,
            status: "error",
            durationMs,
            error,
          });
        }
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
      const confirmedFacility = confirmed
        ? typicalFacilityForSubStage(current.pendingTransition.targetSubStage)
        : current.currentFacility;
      const next: CaseState = {
        ...current,
        version: current.version + 1,
        updatedAt: now,
        currentStage: confirmed ? current.pendingTransition.targetStage : current.currentStage,
        currentSubStage: confirmed ? current.pendingTransition.targetSubStage : current.currentSubStage,
        currentFacility: confirmedFacility,
        currentCapabilities: confirmedFacility?.capabilities ?? [],
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
      const facility = typicalFacilityForSubStage(input.toSubStage);
      const next: CaseState = {
        ...current,
        version: current.version + 1,
        updatedAt: now,
        currentStage: input.toStage,
        currentSubStage: input.toSubStage,
        currentFacility: facility,
        currentCapabilities: [...facility.capabilities],
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
