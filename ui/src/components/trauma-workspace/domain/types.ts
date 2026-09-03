export type MainStage =
  | 'battlefield_first_aid'
  | 'early_treatment'
  | 'specialist_treatment'
  | 'rehabilitation';

export type SubStage =
  | 'primary_first_aid'
  | 'advanced_first_aid'
  | 'emergency_treatment'
  | 'surgical_resuscitation'
  | 'field_specialist_treatment'
  | 'definitive_specialist_treatment'
  | 'functional_recovery'
  | 'psychophysical_rehabilitation';

export type GateStatus = 'ASSESSING' | 'STAY' | 'BLOCKED' | 'READY' | 'COMPLETED';

export type VitalSigns = {
  measuredAt: string;
  respiratoryRate?: number;
  systolicBloodPressure?: number;
  heartRate?: number;
  spo2?: number;
  gcs?: number;
};

export type CaseState = {
  version: number;
  round: number;
  updatedAt: string;
  currentStage: MainStage;
  currentSubStage: SubStage;
  currentFacility: { name: string; type: string; capabilities: string[] };
  currentCapabilities: string[];
  requiredCapabilities: string[];
  vitalSignsHistory: VitalSigns[];
  injuries: Array<{
    id: string;
    bodyPart: string;
    finding: string;
    certainty: 'suspected' | 'confirmed' | 'excluded';
    status: 'active' | 'controlled' | 'worsening' | 'improving';
  }>;
  completedActions: Array<{ id: string; title: string }>;
  currentActions: Array<{ id: string; title: string; description: string }>;
  classificationHistory: Array<{
    version: number;
    severity: string;
    treatmentPriority: string;
    transportPriority: string;
  }>;
  transport: {
    gateStatus: GateStatus;
    blockingReason?: string;
    readiness: 'unknown' | 'ready' | 'not_ready';
  };
  timeline: {
    elapsedMinutes: number;
    recommendedWindowMinutes?: number;
    timingStatus: 'within_window' | 'approaching' | 'exceeded';
  };
  missingInformation: string[];
  memos: Array<{
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

export type CaseSnapshot = {
  eventType: 'agent_turn' | 'transition_confirmation' | 'manual_stage_override';
  round: number;
  createdAt: string;
  triggerMessageId: string;
  state: CaseState;
  response?: {
    treatmentPlan: Array<{ id: string; title: string; description: string }>;
    transition: {
      status: Exclude<GateStatus, 'COMPLETED'>;
      targetStage?: MainStage;
      targetSubStage?: SubStage;
      reason: string;
    };
  };
};

export type TraumaCasePayload = {
  current: CaseState | null;
  snapshots: CaseSnapshot[];
};
