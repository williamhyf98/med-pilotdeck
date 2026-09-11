import { StructuredOutputSchemaError, type StructuredModelClient } from "../modelClient.js";
import { compactCaseStateForDownstream } from "../factMerge.js";
import { REASONER_OUTPUT_SCHEMA, validateReasonerOutput } from "../schemas.js";
import { PRIMARY_FIRST_AID_CAPABILITIES } from "../stageConfig.js";
import type {
  AgentTurnResponse,
  CaseState,
  EvidenceChunk,
  TreatmentAction,
} from "../types.js";
import { REASONER_SYSTEM_PROMPT } from "./reasonerPrompt.js";

const PRIMARY_ACTION_HINTS = [
  ...PRIMARY_FIRST_AID_CAPABILITIES,
  "检伤",
  "监测",
];

export type ReasonerResult = Pick<
  AgentTurnResponse,
  | "naturalLanguageAnswer"
  | "classification"
  | "treatmentPlan"
  | "missingInformation"
  | "transition"
  | "gateAssessment"
  | "memo"
>;

function assertKnownEvidence(
  actions: unknown,
  assessment: unknown,
  promptIds: Set<string>,
): void {
  const cited: string[] = [];
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (action && typeof action === "object" && Array.isArray((action as { evidenceChunkIds?: unknown }).evidenceChunkIds)) {
        cited.push(...(action as { evidenceChunkIds: string[] }).evidenceChunkIds);
      }
    }
  }
  if (assessment && typeof assessment === "object" && Array.isArray((assessment as { evidenceChunkIds?: unknown }).evidenceChunkIds)) {
    cited.push(...(assessment as { evidenceChunkIds: string[] }).evidenceChunkIds);
  }
  if (cited.some((id) => !promptIds.has(id))) {
    throw new StructuredOutputSchemaError("schema validation failed: unknown evidence chunk id");
  }
}

function isAllowedPrimaryAction(action: TreatmentAction): boolean {
  const text = `${action.title}${action.description}`;
  return PRIMARY_ACTION_HINTS.some((hint) => text.includes(hint));
}

function rewritePrimaryAidActions(plan: TreatmentAction[], subStage: CaseState["currentSubStage"]): TreatmentAction[] {
  if (subStage !== "primary_first_aid") return plan;
  return plan.map((action) => {
    if (action.scope !== "current_stage" || isAllowedPrimaryAction(action)) {
      return action;
    }
    return {
      ...action,
      scope: "next_stage",
      professionalConfirmationRequired: true,
    };
  });
}

const OUT_OF_SCOPE_ACTION_PATTERN = /专科治疗|康复治疗|野战专科|确定性专科|功能恢复|身心康复/u;

function constrainTreatmentPlan(
  plan: TreatmentAction[],
  subStage: CaseState["currentSubStage"],
): TreatmentAction[] {
  return rewritePrimaryAidActions(plan, subStage).filter((action) => {
    const text = `${action.title}${action.description}`;
    if (OUT_OF_SCOPE_ACTION_PATTERN.test(text)) return false;
    return subStage !== "surgical_resuscitation" || action.scope !== "next_stage";
  });
}

export function createReasonerStation(model: StructuredModelClient): {
	  reason(input: {
	    state: CaseState;
	    promptChunks: EvidenceChunk[];
	    signal?: AbortSignal;
	    onNaturalLanguageDelta?: (text: string) => void | Promise<void>;
	    onNaturalLanguageEnd?: () => void | Promise<void>;
	  }): Promise<ReasonerResult>;
} {
  return {
    async reason(input) {
      const promptIds = new Set(input.promptChunks.map((chunk) => chunk.id));
      const request = {
        name: "trauma_reason",
        system: REASONER_SYSTEM_PROMPT,
        user: JSON.stringify({
          confirmedPlacement: {
            currentStage: input.state.currentStage,
            currentSubStage: input.state.currentSubStage,
            facility: input.state.currentFacility,
            rationale: input.state.placementRationale ?? null,
          },
          state: compactCaseStateForDownstream(input.state),
          promptChunks: input.promptChunks.map((chunk, index) => ({
            citationIndex: index + 1,
            id: chunk.id,
            title: chunk.documentTitle,
            section: chunk.section,
            chapter: chunk.chapter ?? null,
            heading: chunk.heading ?? null,
            article: chunk.article ?? null,
            path: chunk.path ?? null,
            text: chunk.text,
          })),
        }),
        schema: REASONER_OUTPUT_SCHEMA,
        validate: validateReasonerOutput,
        signal: input.signal,
      };
      const raw = model.streamJson
	        ? await model.streamJson(request, {
	          onNaturalLanguageDelta: input.onNaturalLanguageDelta,
	          onNaturalLanguageEnd: input.onNaturalLanguageEnd,
	        })
        : await model.completeJson(request);

      assertKnownEvidence(raw.treatmentPlan, raw.gateAssessment, promptIds);

      const treatmentPlan = constrainTreatmentPlan(
        raw.treatmentPlan as TreatmentAction[],
        input.state.currentSubStage,
      );
      const transition = {
        ...raw.transition,
        status: raw.transition.status,
        requiresUserConfirmation: false,
      } as ReasonerResult["transition"];

      return {
        naturalLanguageAnswer: raw.naturalLanguageAnswer,
        classification: raw.classification as ReasonerResult["classification"],
        treatmentPlan,
        missingInformation: raw.missingInformation,
        transition,
        gateAssessment: raw.gateAssessment as ReasonerResult["gateAssessment"],
        memo: raw.memo as ReasonerResult["memo"],
      };
    },
  };
}
