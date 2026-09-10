export type MainStage =
  | "battlefield_first_aid"
  | "early_treatment";

export type SubStage =
  | "primary_first_aid"
  | "advanced_first_aid"
  | "emergency_treatment"
  | "surgical_resuscitation";

export type NodeStatus =
  | "not_started"
  | "current"
  | "transfer_preparing"
  | "blocked"
  | "completed";

export type GateStatus = "ASSESSING" | "STAY" | "BLOCKED" | "READY" | "COMPLETED";

export type ClassificationType =
  | "emergency_triage"
  | "reception_triage"
  | "treatment_triage"
  | "evacuation_triage";

export type VitalItemKey =
  | "respiratoryRate"
  | "systolicBloodPressure"
  | "gcs"
  | "heartRate"
  | "temperature"
  | "spo2";

export type ExtractedNarrativeItem = {
  text: string;
  sourceSpan: string;
};

export type ExtractedVitalItem = {
  field: VitalItemKey;
  value: number;
  unit: string;
  sourceSpan: string;
};

export type ExtractedTurnForm = {
  injuryNarratives: ExtractedNarrativeItem[];
  treatmentNarratives: ExtractedNarrativeItem[];
  evacuationNarratives: ExtractedNarrativeItem[];
  notes: ExtractedNarrativeItem[];
  vitals: ExtractedVitalItem[];
};

export type TurnFormInput = {
  statedSubStage: SubStage | null;
  injuryNarrative: string;
  treatmentNarrative: string;
  evacuationNarrative: string;
  note: string;
  vitals: Partial<Record<VitalItemKey, number>>;
};

export type NarrativeEntry = {
  round: number;
  createdAt: string;
  text: string;
};

export type VitalsRoundRecord = {
  round: number;
  recordedAt: string;
  values: Partial<Record<VitalItemKey, number>>;
};

export type ClassificationRecord = {
  version: number;
  type: ClassificationType;
  createdAt: string;
  severity: "unknown" | "mild" | "moderate" | "severe" | "critical";
  treatmentPriority: "pending" | "routine" | "priority" | "urgent";
  transportPriority: "pending" | "routine" | "priority" | "urgent";
  rationale: string[];
};

export type StageTransitionConfirmation = {
  askedAt: string;
  answeredAt?: string;
  answer?: "confirmed" | "declined";
  targetStage: MainStage;
  targetSubStage: SubStage;
  reason: string;
};

export type TransportState = {
  needed: boolean;
  priority: "pending" | "routine" | "priority" | "urgent";
  readiness: "unknown" | "ready" | "not_ready";
  gateStatus: GateStatus;
  blockingReason?: string;
  medicalTargetLevel?: MainStage | SubStage;
  targetFacilityType?: string;
  actualFacilityId?: string;
  confirmation?: StageTransitionConfirmation;
};

export type EvidenceChunk = {
  id: string;
  knowledgeBase: string;
  documentTitle: string;
  section: string;
  article?: string;
  text: string;
  retrievalScore: number;
  rerankScore?: number;
  coverageTags: RagQueryKind[];
  selectedForPrompt: boolean;
  usedInAnswer: boolean;
  retrievalBackend: "remote" | "local";
};

export type RagQueryKind =
  | "stage"
  | "classification_transport"
  | "primary_injury";

export type RetrievalTrace = {
  queries: Array<{
    kind: RagQueryKind;
    query: string;
    reason: string;
    critical: boolean;
    chunkIds: string[];
  }>;
  totalCalls: number;
  allChunkIds: string[];
  promptChunkIds: string[];
  criticalCoverageGaps: string[];
};

export type TreatmentAction = {
  id: string;
  title: string;
  description: string;
  scope: "current_stage" | "next_stage";
  priority: number;
  evidenceChunkIds: string[];
  professionalConfirmationRequired: boolean;
};

export type PlacementAssessment = {
  determined: boolean;
  source: "user_stated" | "definition" | "undetermined" | "out_of_scope";
  stage: MainStage | null;
  subStage: SubStage | null;
  rationale: string;
  definitionReferences: string[];
};

export type RoundMemo = {
  id: string;
  round: number;
  createdAt: string;
  mainStage: MainStage | null;
  subStage: SubStage | null;
  title: string;
  inputPoints: string[];
  actionPoints: string[];
  conclusion: string;
  snapshotVersion: number;
};

export type PatientStateView = {
  updatedAtLabel: string;
  consciousness: string;
  vitals: Array<{
    label: string;
    value: string;
    trend: "up" | "down" | "flat" | "unknown";
    abnormal: boolean;
  }>;
  injuries: Array<{
    label: string;
    certaintyLabel: string;
    statusLabel: string;
  }>;
  completedTreatments: string[];
  facilityLabel: string;
  capabilityLabel: string;
  missingInformation: string[];
};

export type RuleConflict = {
  summary: string;
  evidenceChunkIds: string[];
  resolution?: string;
  unresolved: boolean;
};

export type ClinicalGateAssessment = {
  needHigherCapability: boolean | "unknown";
  requiredCapabilities: string[];
  targetStage?: MainStage;
  targetSubStage?: SubStage;
  transportReadiness: "unknown" | "ready" | "not_ready";
  instabilityIndicators: string[];
  blockingFactors: string[];
  transportPrerequisites: string[];
  ruleConflicts: RuleConflict[];
  confidence: number;
  evidenceChunkIds: string[];
};

export type ManualStageOverride = {
  id: string;
  actorId: string;
  createdAt: string;
  fromStage: MainStage | null;
  fromSubStage: SubStage | null;
  toStage: MainStage;
  toSubStage: SubStage;
  reason: string;
  originalGateStatus: GateStatus;
  unresolvedRisks: string[];
  riskAcknowledged: true;
  blockedOverrideConfirmed: boolean;
};

export type CurrentFacility = {
  id?: string;
  name: string;
  type: string;
  capabilities: string[];
};

export type CaseState = {
  caseId: string;
  sessionId: string;
  projectId: string;
  version: number;
  round: number;
  updatedAt: string;
  currentFacility: CurrentFacility | null;
  currentStage: MainStage | null;
  currentSubStage: SubStage | null;
  placementRationale?: string;
  placementEvidenceChunkIds?: string[];
  injuryNarratives: NarrativeEntry[];
  treatmentNarratives: NarrativeEntry[];
  evacuationNarratives: NarrativeEntry[];
  notes: NarrativeEntry[];
  vitalSignsHistory: VitalsRoundRecord[];
  requiredCapabilities: string[];
  currentCapabilities: string[];
  classificationHistory: ClassificationRecord[];
  transport: TransportState;
  pendingTransition?: StageTransitionConfirmation;
  manualStageOverrides: ManualStageOverride[];
  evidence: EvidenceChunk[];
  memos: RoundMemo[];
  missingInformation: string[];
};

export type AgentTurnResponse = {
  messageId: string;
  caseVersion: number;
  round: number;
  naturalLanguageAnswer: string;
  stage: {
    main: MainStage | null;
    sub: SubStage | null;
  };
  classification: ClassificationRecord;
  treatmentPlan: TreatmentAction[];
  missingInformation: string[];
  transition: {
    status: Exclude<GateStatus, "COMPLETED">;
    targetStage?: MainStage;
    targetSubStage?: SubStage;
    reason: string;
    requiresUserConfirmation: boolean;
  };
  gateAssessment: ClinicalGateAssessment;
  placement: PlacementAssessment;
  memo: Omit<RoundMemo, "id" | "createdAt" | "snapshotVersion">;
  evidence: EvidenceChunk[];
};

export type CaseSnapshot = {
  eventType: "agent_turn" | "transition_confirmation" | "manual_stage_override";
  round: number;
  createdAt: string;
  triggerMessageId: string;
  state: CaseState;
  form?: TurnFormInput;
  rawInput?: string;
  retrieval?: RetrievalTrace;
  response?: AgentTurnResponse;
};
