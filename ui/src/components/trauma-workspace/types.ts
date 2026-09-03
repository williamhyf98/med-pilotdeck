export type MainStageId = 'initial' | 'early' | 'specialist' | 'rehab';

export type WorkflowStatus = 'future' | 'current' | 'done' | 'transfer' | 'blocked';

export type GateStatus = 'ASSESSING' | 'READY' | 'BLOCKED' | 'COMPLETED';

export type Trend = 'up' | 'down' | 'flat' | 'unknown';

export type StageDefinition = {
  id: MainStageId;
  index: string;
  name: string;
  note: string;
  substeps: Array<{ name: string; note: string }>;
};

export type PatientVital = {
  label: string;
  value: string;
  trend: Trend;
  abnormal?: boolean;
};

export type PatientInjury = {
  label: string;
  certainty: '已确认' | '疑似' | '已排除';
  status: string;
};

export type PatientStateView = {
  updatedAt: string;
  consciousness: string;
  vitals: PatientVital[];
  injuries: PatientInjury[];
  treatments: string[];
  missingInformation: string[];
};

export type DemoMessage = {
  role: 'user' | 'assistant';
  text: string;
  /** 阶段转换确认，渲染为 AskUserQuestion 工具卡片。 */
  ask?: {
    header: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    answer: string;
  };
};

export type RoundMemo = {
  id: string;
  round: number;
  title: string;
  time: string;
  elapsed: string;
  stageId: MainStageId;
  substepIndex: number;
  facility: string;
  capability: string;
  transitionLabel: string;
  transitionTone?: 'warning' | 'danger' | 'success';
  nextTarget: string;
  inputPoints: string[];
  actionPoints: string[];
  conclusion: string;
  patient: PatientStateView;
  classification: {
    label: string;
    severity: string;
    treatmentPriority: string;
    transportPriority: string;
  };
  timing: {
    window: string;
    status: string;
    warning?: boolean;
  };
  gate: {
    status: GateStatus;
    title: string;
    description: string;
    confirmation: string;
  };
  actions: string[];
  nextStageCapability: string;
  messages: DemoMessage[];
  evidence: Array<{
    id: string;
    title: string;
    score: string;
    source: '远程知识库' | '本地语料';
    used: boolean;
    text: string;
  }>;
};
