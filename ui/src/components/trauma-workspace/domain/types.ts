export type MainStage = 'battlefield_first_aid' | 'early_treatment';

export type SubStage =
  | 'primary_first_aid'
  | 'advanced_first_aid'
  | 'emergency_treatment'
  | 'surgical_resuscitation';

export type GateStatus = 'ASSESSING' | 'STAY' | 'BLOCKED' | 'READY' | 'COMPLETED';

export type VitalItemKey =
  | 'respiratoryRate'
  | 'systolicBloodPressure'
  | 'gcs'
  | 'heartRate'
  | 'temperature';

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
  type: 'emergency_triage' | 'reception_triage' | 'treatment_triage' | 'evacuation_triage';
  createdAt: string;
  severity: 'unknown' | 'mild' | 'moderate' | 'severe' | 'critical';
  treatmentPriority: 'pending' | 'routine' | 'priority' | 'urgent';
  transportPriority: 'pending' | 'routine' | 'priority' | 'urgent';
  rationale: string[];
};

export type CaseState = {
  caseId: string;
  sessionId: string;
  projectId: string;
  version: number;
  round: number;
  updatedAt: string;
  currentStage: MainStage | null;
  currentSubStage: SubStage | null;
  currentFacility: { id?: string; name: string; type: string; capabilities: string[] } | null;
  currentCapabilities: string[];
  requiredCapabilities: string[];
  placementRationale?: string;
  placementEvidenceChunkIds?: string[];
  injuryNarratives: NarrativeEntry[];
  treatmentNarratives: NarrativeEntry[];
  evacuationNarratives: NarrativeEntry[];
  notes: NarrativeEntry[];
  vitalSignsHistory: VitalsRoundRecord[];
  classificationHistory: ClassificationRecord[];
  transport: {
    needed: boolean;
    priority: 'pending' | 'routine' | 'priority' | 'urgent';
    gateStatus: GateStatus;
    blockingReason?: string;
    readiness: 'unknown' | 'ready' | 'not_ready';
  };
  pendingTransition?: unknown;
  manualStageOverrides: unknown[];
  missingInformation: string[];
  memos: Array<{
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
  }>;
  evidence: Array<{
    id: string;
    documentTitle: string;
    section: string;
    text: string;
    retrievalScore: number;
    retrievalBackend: 'remote' | 'local';
    usedInAnswer: boolean;
  }>;
};

export type AgentTurnResponse = {
  naturalLanguageAnswer: string;
  treatmentPlan: Array<{ id: string; title: string; description: string }>;
  placement?: {
    source: 'user_stated' | 'definition' | 'undetermined' | 'out_of_scope';
    subStage: SubStage | null;
  };
  transition: {
    status: Exclude<GateStatus, 'COMPLETED'>;
    targetStage?: MainStage;
    targetSubStage?: SubStage;
    reason: string;
  };
};

export type CaseSnapshot = {
  eventType: 'agent_turn' | 'transition_confirmation' | 'manual_stage_override';
  round: number;
  createdAt: string;
  triggerMessageId: string;
  state: CaseState;
  form?: TurnFormInput;
  response?: AgentTurnResponse;
};

export type TraumaCasePayload = {
  current: CaseState | null;
  snapshots: CaseSnapshot[];
};
