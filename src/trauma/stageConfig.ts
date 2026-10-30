import type {
  CaseState,
  CurrentFacility,
  MainStage,
  NodeStatus,
  SubStage,
} from "./types.js";

export const SUBSTAGE_ORDER = [
  "primary_first_aid",
  "advanced_first_aid",
  "emergency_treatment",
  "surgical_resuscitation",
] as const satisfies readonly SubStage[];

export const SUBSTAGE_TO_MAIN: Record<SubStage, MainStage> = {
  primary_first_aid: "battlefield_first_aid",
  advanced_first_aid: "battlefield_first_aid",
  emergency_treatment: "early_treatment",
  surgical_resuscitation: "early_treatment",
};

export const PRIMARY_FIRST_AID_CAPABILITIES = [
  "检伤评估",
  "止血",
  "通气",
  "包扎",
  "固定",
  "搬运",
  "心肺复苏",
  "生命体征监测",
] as const;

export const TYPICAL_FACILITY_BY_SUBSTAGE: Record<SubStage, CurrentFacility> = {
  primary_first_aid: {
    name: "连抢救组",
    type: "company_aid_team",
    capabilities: [...PRIMARY_FIRST_AID_CAPABILITIES],
  },
  advanced_first_aid: {
    name: "营救护站",
    type: "battalion_aid_station",
    capabilities: [...PRIMARY_FIRST_AID_CAPABILITIES, "高级气道", "抗休克"],
  },
  emergency_treatment: {
    name: "旅（团）救护所",
    type: "regiment_aid_station",
    capabilities: ["紧急处置", "抗休克治疗", "后送准备"],
  },
  surgical_resuscitation: {
    name: "医务中心",
    type: "medical_center",
    capabilities: ["损伤控制手术", "休克复苏监护"],
  },
};

export function typicalFacilityForSubStage(subStage: SubStage): CurrentFacility {
  return { ...TYPICAL_FACILITY_BY_SUBSTAGE[subStage], capabilities: [...TYPICAL_FACILITY_BY_SUBSTAGE[subStage].capabilities] };
}

export function isLaterSubStage(from: SubStage | null | undefined, to: SubStage): boolean {
  const toIndex = SUBSTAGE_ORDER.indexOf(to);
  if (toIndex < 0) return false;
  if (!from) return true;
  const fromIndex = SUBSTAGE_ORDER.indexOf(from);
  return fromIndex >= 0 && toIndex > fromIndex;
}

export function deriveNodeStatus(
  state: Pick<CaseState, "currentSubStage" | "transport" | "pendingTransition">,
  node: SubStage,
): NodeStatus {
  if (!state.currentSubStage) return "not_started";
  const currentIndex = SUBSTAGE_ORDER.indexOf(state.currentSubStage);
  const nodeIndex = SUBSTAGE_ORDER.indexOf(node);
  if (nodeIndex < currentIndex) return "completed";
  if (nodeIndex > currentIndex) return "not_started";
  if (state.transport.gateStatus === "BLOCKED") return "blocked";
  if (state.transport.gateStatus === "READY" && state.pendingTransition) {
    return "transfer_preparing";
  }
  return "current";
}

export function initialCaseState(input: {
  projectId: string;
  sessionId: string;
  now: string;
  caseId?: string;
}): CaseState {
  return {
    caseId: input.caseId ?? input.sessionId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    version: 0,
    round: 0,
    updatedAt: input.now,
    currentFacility: null,
    currentStage: null,
    currentSubStage: null,
    injuryNarratives: [],
    treatmentNarratives: [],
    evacuationNarratives: [],
    notes: [],
    vitalSignsHistory: [],
    requiredCapabilities: [],
    currentCapabilities: [],
    classificationHistory: [],
    transport: {
      needed: false,
      priority: "pending",
      readiness: "unknown",
      gateStatus: "ASSESSING",
    },
    manualStageOverrides: [],
    evidence: [],
    memos: [],
    missingInformation: [],
  };
}
