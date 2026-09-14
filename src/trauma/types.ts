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

export type TraumaInputIntent =
  | "case_update"
  | "out_of_scope"
  | "domain_question_no_case"
  | "system_help";

export type ExtractedTurnForm = {
  /**
   * 本轮输入意图。缺省只用于兼容旧测试/历史数据；新 extractor schema 要求必须输出。
   * 只有 case_update 会继续进入 runner，其余类型由网关固定话术直接结束本轮。
   */
  inputIntent?: TraumaInputIntent;
  /** 一句话说明意图判断依据，主要用于日志/调试，不展示给用户。 */
  scopeReason?: string;
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
  chapter?: string;
  heading?: string;
  path?: string;
  article?: string;
  text: string;
  retrievalScore: number;
  rerankScore?: number;
  coverageTags: RagQueryKind[];
  selectedForPrompt: boolean;
  usedInAnswer: boolean;
  /**
   * 该知识块在本轮 promptChunks 中的序号 + 1，与正文角标 [N] 和参考来源列表
   * 使用同一个编号。未进入 promptChunks 的知识块没有编号。
   */
  citationIndex?: number;
  retrievalBackend: "remote" | "local";
};

export type CitationMetadata = {
  /** 引用编号，对应正文中的 [N] */
  index: number;
  /** 文献名或知识块标题 */
  title: string;
  /** 章节路径 */
  section: string;
  /** @deprecated 短引文已下线；字段保留仅为兼容历史消息的反序列化。 */
  quote?: string;
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
