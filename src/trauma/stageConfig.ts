import type {
  CaseState,
  MainStage,
  NodeStatus,
  SubStage,
} from "./types.js";

export const SUBSTAGE_ORDER = [
  "primary_first_aid",
  "advanced_first_aid",
  "emergency_treatment",
  "surgical_resuscitation",
  "field_specialist_treatment",
  "definitive_specialist_treatment",
  "functional_recovery",
  "psychophysical_rehabilitation",
] as const satisfies readonly SubStage[];

export const SUBSTAGE_TO_MAIN: Record<SubStage, MainStage> = {
  primary_first_aid: "battlefield_first_aid",
  advanced_first_aid: "battlefield_first_aid",
  emergency_treatment: "early_treatment",
  surgical_resuscitation: "early_treatment",
  field_specialist_treatment: "specialist_treatment",
  definitive_specialist_treatment: "specialist_treatment",
  functional_recovery: "rehabilitation",
  psychophysical_rehabilitation: "rehabilitation",
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

export function isLaterSubStage(from: SubStage, to: SubStage): boolean {
  return SUBSTAGE_ORDER.indexOf(to) > SUBSTAGE_ORDER.indexOf(from);
}

export function deriveNodeStatus(
  state: Pick<CaseState, "currentSubStage" | "transport" | "pendingTransition">,
  node: SubStage,
): NodeStatus {
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
    currentFacility: {
      name: "连抢救组",
      type: "company_aid_team",
      capabilities: [...PRIMARY_FIRST_AID_CAPABILITIES],
    },
    currentStage: "battlefield_first_aid",
    currentSubStage: "primary_first_aid",
    injuries: [],
    vitalSignsHistory: [],
    completedActions: [],
    currentActions: [],
    requiredCapabilities: [],
    currentCapabilities: [...PRIMARY_FIRST_AID_CAPABILITIES],
    classificationHistory: [],
    transport: {
      needed: false,
      priority: "pending",
      readiness: "unknown",
      gateStatus: "ASSESSING",
    },
    manualStageOverrides: [],
    timeline: {
      injuryTime: "",
      currentTime: input.now,
      elapsedMinutes: 0,
      timingStatus: "within_window",
      isHardGate: false,
    },
    evidence: [],
    memos: [],
    missingInformation: [],
    conflictingFactIds: [],
  };
}
