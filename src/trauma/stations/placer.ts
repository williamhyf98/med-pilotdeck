import type { StructuredModelClient } from "../modelClient.js";
import {
  PLACEMENT_OUTPUT_SCHEMA,
  validatePlacementAssessment,
} from "../schemas.js";
import { compactCaseStateForDownstream } from "../factMerge.js";
import type { CaseState, PlacementAssessment } from "../types.js";
import { PLACEMENT_SYSTEM_PROMPT } from "./placementPrompt.js";

export function createPlacementStation(model: StructuredModelClient): {
  place(input: { state: CaseState; signal?: AbortSignal }): Promise<PlacementAssessment>;
} {
  return {
    async place(input) {
      const raw = await model.completeJson<PlacementAssessment>({
        name: "trauma_place",
        system: PLACEMENT_SYSTEM_PROMPT,
        user: JSON.stringify({
          previousPlacement: {
            stage: input.state.currentStage,
            subStage: input.state.currentSubStage,
          },
          caseHistory: compactCaseStateForDownstream(input.state),
        }),
        schema: PLACEMENT_OUTPUT_SCHEMA,
        validate: validatePlacementAssessment,
        signal: input.signal,
      });
      return {
        ...raw,
        stage: raw.determined ? raw.stage : null,
        subStage: raw.determined ? raw.subStage : null,
      };
    },
  };
}
