import { SUBSTAGE_TO_MAIN, typicalFacilityForSubStage } from "./stageConfig.js";
import type { CurrentFacility, MainStage, PlacementAssessment, SubStage } from "./types.js";

export type ResolvedPlacement = {
  determined: boolean;
  stage: MainStage | null;
  subStage: SubStage | null;
  facility: CurrentFacility | null;
  rationale: string;
  evidenceChunkIds: string[];
};

const EMPTY_PLACEMENT: ResolvedPlacement = {
  determined: false,
  stage: null,
  subStage: null,
  facility: null,
  rationale: "",
  evidenceChunkIds: [],
};

/**
 * 只有同时具备合法主级/子级映射和非空理由时才落位；
 * 按固化定义推断时还必须列出命中的定义标题。
 * 否则保持全空，不得回退到Ⅰ级初级急救。
 */
export function resolveStagePlacement(input: {
  placement: PlacementAssessment | undefined;
}): ResolvedPlacement {
  const placement = input.placement;
  if (!placement?.determined || !placement.stage || !placement.subStage) {
    return {
      ...EMPTY_PLACEMENT,
      rationale: placement?.rationale?.trim() ?? "",
    };
  }
  if (SUBSTAGE_TO_MAIN[placement.subStage] !== placement.stage) {
    return { ...EMPTY_PLACEMENT, rationale: placement.rationale.trim() };
  }
  if (
    placement.rationale.trim().length === 0
    || (placement.source === "definition" && placement.definitionReferences.length === 0)
  ) {
    return { ...EMPTY_PLACEMENT, rationale: placement.rationale.trim() };
  }

  const typical = typicalFacilityForSubStage(placement.subStage);
  return {
    determined: true,
    stage: placement.stage,
    subStage: placement.subStage,
    facility: typical,
    rationale: placement.rationale.trim(),
    evidenceChunkIds: [],
  };
}
