import { StructuredOutputSchemaError, type StructuredModelClient } from "../modelClient.js";
import { REASONER_OUTPUT_SCHEMA, validateReasonerOutput } from "../schemas.js";
import { PRIMARY_FIRST_AID_CAPABILITIES } from "../stageConfig.js";
import type {
  AgentTurnResponse,
  CaseState,
  EvidenceChunk,
  TimelineState,
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

function assertKnownEvidence(actions: unknown, assessment: unknown, promptIds: Set<string>): void {
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

export function createReasonerStation(model: StructuredModelClient): {
  reason(input: {
    state: CaseState;
    timeline: TimelineState;
    promptChunks: EvidenceChunk[];
  }): Promise<ReasonerResult>;
} {
  return {
    async reason(input) {
      const promptIds = new Set(input.promptChunks.map((chunk) => chunk.id));
      const raw = await model.completeJson({
        name: "trauma_reason",
        system: REASONER_SYSTEM_PROMPT,
        user: JSON.stringify({
          state: {
            currentStage: input.state.currentStage,
            currentSubStage: input.state.currentSubStage,
            facility: input.state.currentFacility,
            injuries: input.state.injuries,
            latestVitals: input.state.vitalSignsHistory.at(-1) ?? null,
            capabilities: input.state.currentCapabilities,
          },
          timeline: input.timeline,
          promptChunks: input.promptChunks.map((chunk) => ({
            id: chunk.id,
            title: chunk.documentTitle,
            section: chunk.section,
            text: chunk.text,
          })),
        }),
        schema: REASONER_OUTPUT_SCHEMA,
        validate: validateReasonerOutput,
      });

      assertKnownEvidence(raw.treatmentPlan, raw.gateAssessment, promptIds);

      const treatmentPlan = rewritePrimaryAidActions(
        raw.treatmentPlan as TreatmentAction[],
        input.state.currentSubStage,
      );
      const transition = {
        ...raw.transition,
        status: raw.transition.status,
        requiresUserConfirmation: raw.transition.status === "READY" ? true : raw.transition.requiresUserConfirmation,
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
