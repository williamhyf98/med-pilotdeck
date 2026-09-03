export type MainStage =
  | "battlefield_first_aid"
  | "early_treatment"
  | "specialist_treatment"
  | "rehabilitation";

export type SubStage =
  | "primary_first_aid"
  | "advanced_first_aid"
  | "emergency_treatment"
  | "surgical_resuscitation"
  | "field_specialist_treatment"
  | "definitive_specialist_treatment"
  | "functional_recovery"
  | "psychophysical_rehabilitation";

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

export type VitalSigns = {
  measuredAt: string;
  sourceMessageId: string;
  respiratoryRate?: number;
  systolicBloodPressure?: number;
  diastolicBloodPressure?: number;
  heartRate?: number;
  spo2?: number;
  gcs?: number;
  temperature?: number;
};

export type InjuryFinding = {
  id: string;
  category: string;
  bodyPart: string;
  finding: string;
  certainty: "suspected" | "confirmed" | "excluded";
  status: "active" | "controlled" | "worsening" | "improving";
  sourceMessageId: string;
  sourceQuote: string;
  confidence: number;
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

export type TimelineState = {
  injuryTime: string;
  currentTime: string;
  elapsedMinutes: number;
  recommendedWindowMinutes?: number;
  timingStatus: "within_window" | "approaching" | "exceeded";
  isHardGate: false;
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
  | "primary_injury"
  | "supplemental";

export type RetrievalTrace = {
  queries: Array<{
    wave: 1 | 2;
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

export type ExtractedFact<T = unknown> = {
  value: T;
  sourceMessageId: string;
  sourceQuote: string;
  measuredAt?: string;
  certainty: "confirmed" | "suspected" | "excluded" | "unknown";
  confidence: number;
  supersedesFactId?: string;
};

export type ExtractedVital = {
  type:
    | "respiratory_rate"
    | "blood_pressure"
    | "heart_rate"
    | "spo2"
    | "gcs"
    | "temperature";
  value: number | { systolic: number; diastolic?: number };
  unit: string;
};

export type ExtractedTurnFacts = {
  turnKind: "case_update" | "correction" | "question" | "no_case_update";
  context: {
    eventTime?: ExtractedFact<string>;
    location?: ExtractedFact<string>;
    facility?: ExtractedFact<string>;
  };
  vitalSigns: Array<ExtractedFact<ExtractedVital>>;
  injuryFindings: Array<ExtractedFact<{
    bodyPart: string;
    finding: string;
    status?: "active" | "controlled" | "worsening" | "improving";
  }>>;
  treatmentEvents: Array<ExtractedFact<{
    action: string;
    status: "planned" | "in_progress" | "completed";
    effect?: "effective" | "ineffective" | "worsened" | "unknown";
  }>>;
  careAndTransportFacts: Array<ExtractedFact<{
    type: "capability" | "capability_gap" | "destination" | "transport_mode" | "transport_constraint";
    description: string;
  }>>;
  correctionsAndProvenance: {
    conflictingFactIds: string[];
  };
  extensions?: Array<ExtractedFact<{ type: string; data: unknown }>>;
};

export type RoundMemo = {
  id: string;
  round: number;
  createdAt: string;
  mainStage: MainStage;
  subStage: SubStage;
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
  fromStage: MainStage;
  fromSubStage: SubStage;
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
  currentFacility: CurrentFacility;
  currentStage: MainStage;
  currentSubStage: SubStage;
  injuries: InjuryFinding[];
  vitalSignsHistory: VitalSigns[];
  completedActions: TreatmentAction[];
  currentActions: TreatmentAction[];
  requiredCapabilities: string[];
  currentCapabilities: string[];
  classificationHistory: ClassificationRecord[];
  transport: TransportState;
  pendingTransition?: StageTransitionConfirmation;
  manualStageOverrides: ManualStageOverride[];
  timeline: TimelineState;
  evidence: EvidenceChunk[];
  memos: RoundMemo[];
  missingInformation: string[];
  conflictingFactIds: string[];
};

export type AgentTurnResponse = {
  messageId: string;
  round: number;
  naturalLanguageAnswer: string;
  stage: {
    main: MainStage;
    sub: SubStage;
  };
  classification: ClassificationRecord;
  treatmentPlan: TreatmentAction[];
  missingInformation: string[];
  timeline: TimelineState;
  transition: {
    status: Exclude<GateStatus, "COMPLETED">;
    targetStage?: MainStage;
    targetSubStage?: SubStage;
    reason: string;
    requiresUserConfirmation: boolean;
  };
  gateAssessment: ClinicalGateAssessment;
  memo: Omit<RoundMemo, "id" | "createdAt" | "snapshotVersion">;
  evidence: EvidenceChunk[];
};

export type CaseSnapshot = {
  eventType: "agent_turn" | "transition_confirmation" | "manual_stage_override";
  round: number;
  createdAt: string;
  triggerMessageId: string;
  state: CaseState;
  retrieval?: RetrievalTrace;
  response?: AgentTurnResponse;
};
