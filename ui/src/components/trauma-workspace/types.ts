export type MainStageId =
  | 'battlefield_first_aid'
  | 'early_treatment';

export type WorkflowStatus = 'future' | 'current' | 'done' | 'transfer' | 'blocked';

export type GateStatus = 'ASSESSING' | 'STAY' | 'READY' | 'BLOCKED' | 'COMPLETED';

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
  /** 触发该轮推演的聊天消息/run id，用于实时快照与聊天事件关联。 */
  triggerMessageId?: string;
  snapshotVersion?: number;
  round: number;
  title: string;
  time: string;
  /** 级别待确认的轮次为 null，不得回退到首个主级/子级。 */
  stageId: MainStageId | null;
  substepIndex: number | null;
  unplaced?: boolean;
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
    /** 与正文角标、参考来源列表共用的引用编号；未进入 promptChunks 时为空。 */
    citationIndex?: number;
    text: string;
  }>;
};
