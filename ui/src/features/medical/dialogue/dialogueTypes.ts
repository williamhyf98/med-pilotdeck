export type DialogueCapabilities = {
  dialogue: boolean;
  rag: boolean;
  attachments: boolean;
  tables: boolean;
  imaging: boolean;
  reasons: Partial<Record<'rag' | 'attachments' | 'tables' | 'imaging', string>>;
};

export type DialogueCorpus = {
  id: string;
  name: string;
  description?: string;
  ready?: boolean;
  reason?: string;
  documentCount?: number;
  updatedAt?: string;
};

export type SamplingSettings = {
  temperature: number;
  topP: number;
  maxOutputTokens: number;
};

export type ManagedPromptId = 'clinical-safe' | 'evidence-first' | 'concise-handoff';

export type ManagedPrompt = {
  id: ManagedPromptId;
  label: string;
  description: string;
  instructions: string;
};

export type PreparedAttachment = {
  id: string;
  file: File;
  status: 'queued' | 'parsing' | 'ready' | 'degraded' | 'unsupported' | 'error';
  previewUrl?: string;
  result?: unknown;
  error?: string;
  /** Per-file parse note from sidecar (e.g. "PDF text only, images skipped"). */
  parseNote?: string;
};

export const DEFAULT_CAPABILITIES: DialogueCapabilities = {
  dialogue: false,
  rag: false,
  attachments: false,
  tables: false,
  imaging: false,
  reasons: {},
};

export const MANAGED_PROMPTS: ManagedPrompt[] = [
  {
    id: 'clinical-safe',
    label: '临床安全',
    description: '默认区分事实、推测和风险信号。',
    instructions: '区分事实、推测与信息缺口；先提示需要紧急线下处置的风险信号。',
  },
  {
    id: 'evidence-first',
    label: '证据优先',
    description: '优先给出证据等级和可核验出处。',
    instructions: '按证据强度组织回答；为关键结论给出可核验来源，不得虚构引用。',
  },
  {
    id: 'concise-handoff',
    label: '交接摘要',
    description: '输出适合医疗交接的精简结构。',
    instructions: '使用“现状、关键风险、已知处置、待确认、下一步”结构，保持简洁。',
  },
];
