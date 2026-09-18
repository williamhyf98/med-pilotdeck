import type {
  MemoryCandidate,
  MemoryManifestEntry,
  MemoryMessage,
  MemoryRoute,
  MemoryUserSummary,
  ProjectIdentityHint,
  ProjectMetaRecord,
  ProjectShortlistCandidate,
  RecallHeaderEntry,
  RetrievalPromptDebug,
} from "../types.js";
import { redact } from "../../MemoryPrivacyPolicy.js";
import {
  type MemoryPromptProfile,
  GENERAL_MEDICINE_PROFILE,
  resolveMemoryPromptProfile,
} from "./prompts/index.js";

type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type ProviderHeaders = Record<string, string> | undefined;
type PromptDebugSink = (debug: RetrievalPromptDebug) => void;

const REQUEST_RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_REQUEST_MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_RETRY_BASE_DELAY_MS = 1_000;

export interface FileMemoryExtractionDiscardedCandidate {
  reason: string;
  candidateType?: "user" | "feedback" | "project";
  candidateName?: string;
  summary?: string;
}

export interface FileMemoryExtractionDebug {
  parsedItems: unknown[];
  normalizedCandidates: MemoryCandidate[];
  discarded: FileMemoryExtractionDiscardedCandidate[];
  finalCandidates: MemoryCandidate[];
  fallbackApplied?: string;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatusCode(error: unknown): number | null {
  if (
    error
    && typeof error === "object"
    && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return null;
}

function isTransientRequestError(error: unknown): boolean {
  const status = getErrorStatusCode(error);
  if (status !== null) return REQUEST_RETRYABLE_STATUS_CODES.has(status);
  if (isTimeoutError(error)) return true;
  if (!(error instanceof Error)) return false;
  return /(fetch failed|network|econnreset|econnrefused|etimedout|socket hang up|temporar|rate limit|too many requests)/i
    .test(error.message);
}

function computeRetryDelayMs(attemptIndex: number): number {
  return DEFAULT_REQUEST_RETRY_BASE_DELAY_MS * (2 ** attemptIndex);
}

function resolveRequestTimeoutMs(timeoutMs: number | undefined): number | null {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return 30_000;
  if (timeoutMs <= 0) return null;
  return timeoutMs;
}

interface ModelSelection {
  provider: string;
  model: string;
  api: string;
  baseUrl?: string;
  headers?: ProviderHeaders;
}

export interface RawUserProfilePayload {
  identity_background_markdown?: unknown;
  /** Legacy alias kept so profiles written before Task 4 still parse. */
  identity_background?: unknown;
  specialty_markdown?: unknown;
  /** Legacy model output. Accepted for parsing but intentionally not persisted. */
  clinical_preference_markdown?: unknown;
}

type MemoryCreateKind = "user" | "project" | "feedback";

export interface MemoryClassificationLabel {
  type: MemoryCreateKind;
  reason: string;
  evidence: string;
}

export interface FileMemoryClassificationResult {
  shouldStore: boolean;
  labels: MemoryClassificationLabel[];
}

interface RawMemoryClassificationLabelPayload {
  type?: unknown;
  reason?: unknown;
  evidence?: unknown;
}

interface RawMemoryClassificationPayload {
  should_store?: unknown;
  labels?: unknown;
}

interface RawMemoryCreatePayload {
  skip?: unknown;
  reason?: unknown;
  name?: unknown;
  description?: unknown;
  markdown?: unknown;
}

interface RawDreamFileGlobalPlanProjectPayload {
  plan_key?: unknown;
  target_project_id?: unknown;
  project_name?: unknown;
  description?: unknown;
  status?: unknown;
  merge_reason?: unknown;
  evidence_entry_ids?: unknown;
  retained_entry_ids?: unknown;
}

interface RawDreamFileGlobalPlanPayload {
  summary?: unknown;
  duplicate_topic_count?: unknown;
  conflict_topic_count?: unknown;
  projects?: unknown;
  deleted_project_ids?: unknown;
  deleted_entry_ids?: unknown;
}

interface RawDreamFileProjectRewriteFilePayload {
  type?: unknown;
  name?: unknown;
  description?: unknown;
  source_entry_ids?: unknown;
  stage?: unknown;
  decisions?: unknown;
  constraints?: unknown;
  next_steps?: unknown;
  blockers?: unknown;
  timeline?: unknown;
  notes?: unknown;
  rule?: unknown;
  why?: unknown;
  how_to_apply?: unknown;
}

interface RawDreamFileProjectRewritePayload {
  summary?: unknown;
  project_meta?: unknown;
  files?: unknown;
  deleted_entry_ids?: unknown;
}

interface RawDreamClusterPayload {
  member_relative_paths?: unknown;
  reason?: unknown;
}

interface RawDreamClusterPlanPayload {
  summary?: unknown;
  clusters?: unknown;
}

interface RawDreamClusterRefinePayload {
  summary?: unknown;
  name?: unknown;
  description?: unknown;
  markdown?: unknown;
}

interface RawProjectMetaReviewPayload {
  should_update?: unknown;
  reason?: unknown;
  project_name?: unknown;
  description?: unknown;
  status?: unknown;
}

interface RawGeneralProjectMetaMergeGroupPayload {
  keeper_project_id?: unknown;
  duplicate_project_ids?: unknown;
  reason?: unknown;
}

interface RawGeneralProjectMetaMergePlanPayload {
  summary?: unknown;
  merge_groups?: unknown;
}

const DEFAULT_DREAM_FILE_PLAN_TIMEOUT_MS = 600_000;
const DEFAULT_DREAM_FILE_PROJECT_REWRITE_TIMEOUT_MS = 300_000;
const DEFAULT_DREAM_CLUSTER_PLAN_TIMEOUT_MS = 180_000;
const DEFAULT_DREAM_CLUSTER_REFINE_TIMEOUT_MS = 180_000;
const DEFAULT_DREAM_PROJECT_META_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_GENERAL_PROJECT_META_MERGE_TIMEOUT_MS = 120_000;
const DEFAULT_USER_PROFILE_REWRITE_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_GATE_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_SELECTION_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS = 75_000;

// These 4 constants are re-exported from the general_medicine prompt profile so
// that their values remain accessible at this path (the prompts.test.ts snapshot
// test imports from here). Task 5 is a pure mechanical move — the strings are
// identical to the inline definitions that lived here before.
export const MEMORY_CLASSIFICATION_SYSTEM_PROMPT = GENERAL_MEDICINE_PROFILE.classify;

export const USER_NOTE_CREATE_SYSTEM_PROMPT = GENERAL_MEDICINE_PROFILE.noteCreate.user!;
export const PROJECT_NOTE_CREATE_SYSTEM_PROMPT = GENERAL_MEDICINE_PROFILE.noteCreate.project!;
export const FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT = GENERAL_MEDICINE_PROFILE.noteCreate.feedback;

export interface LlmDreamFileProjectMetaInput {
  projectId: string;
  projectName: string;
  description: string;
  status: string;
  updatedAt: string;
  dreamUpdatedAt?: string;
  sourceKind?: string;
  sourceWorkspacePath?: string;
  sourceProjectId?: string;
}

export interface LlmDreamFileRecordInput {
  entryId: string;
  relativePath: string;
  type: "project" | "feedback";
  scope: "project";
  projectId?: string;
  isTmp: boolean;
  name: string;
  description: string;
  updatedAt: string;
  capturedAt?: string;
  sourceSessionKey?: string;
  content: string;
  project?: {
    stage: string;
    decisions: string[];
    constraints: string[];
    nextSteps: string[];
    blockers: string[];
    timeline: string[];
    notes: string[];
  };
  feedback?: {
    rule: string;
    why: string;
    howToApply: string;
    notes: string[];
  };
}

export interface LlmDreamFileGlobalPlanInput {
  currentProjects: LlmDreamFileProjectMetaInput[];
  records: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamFileGlobalPlanProject {
  planKey: string;
  targetProjectId?: string;
  projectName: string;
  description: string;
  status: string;
  mergeReason?: "rename" | "alias_equivalence" | "duplicate_formal_project";
  evidenceEntryIds: string[];
  retainedEntryIds: string[];
}

export interface LlmDreamFileGlobalPlanOutput {
  summary: string;
  duplicateTopicCount: number;
  conflictTopicCount: number;
  projects: LlmDreamFileGlobalPlanProject[];
  deletedProjectIds: string[];
  deletedEntryIds: string[];
}

export interface LlmDreamFileProjectRewriteInput {
  project: LlmDreamFileGlobalPlanProject & { projectId: string };
  currentMeta: LlmDreamFileProjectMetaInput | null;
  records: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamFileProjectRewriteOutputFile {
  type: "project" | "feedback";
  name: string;
  description: string;
  sourceEntryIds: string[];
  stage?: string;
  decisions?: string[];
  constraints?: string[];
  nextSteps?: string[];
  blockers?: string[];
  timeline?: string[];
  notes?: string[];
  rule?: string;
  why?: string;
  howToApply?: string;
}

export interface LlmDreamFileProjectRewriteOutput {
  summary: string;
  projectMeta: {
    projectName: string;
    description: string;
    status: string;
  };
  files: LlmDreamFileProjectRewriteOutputFile[];
  deletedEntryIds: string[];
}

export interface LlmGeneralProjectMetaMergeInput {
  projectMetas: LlmDreamFileProjectMetaInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmGeneralProjectMetaMergeGroup {
  keeperProjectId: string;
  duplicateProjectIds: string[];
  reason: string;
}

export interface LlmGeneralProjectMetaMergeOutput {
  summary: string;
  mergeGroups: LlmGeneralProjectMetaMergeGroup[];
}

export interface LlmDreamClusterHeaderInput {
  relativePath: string;
  name: string;
  description: string;
  updatedAt: string;
}

export interface LlmDreamCluster {
  memberRelativePaths: string[];
  reason: string;
}

export interface LlmDreamClusterPlanInput {
  kind: "project" | "feedback";
  headers: LlmDreamClusterHeaderInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamClusterPlanOutput {
  summary: string;
  clusters: LlmDreamCluster[];
}

export interface LlmDreamClusterRefineInput {
  kind: "project" | "feedback";
  records: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamClusterRefineOutput {
  summary: string;
  file: {
    name: string;
    description: string;
    markdown: string;
  } | null;
}

export interface LlmDreamProjectMetaReviewInput {
  currentMeta: LlmDreamFileProjectMetaInput;
  recentProjectRecords: LlmDreamFileRecordInput[];
  recentFeedbackRecords: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamProjectMetaReviewOutput {
  shouldUpdate: boolean;
  reason: string;
  projectMeta: {
    projectName: string;
    description: string;
    status: string;
  };
}

const EXTRACTION_SYSTEM_PROMPT = `
你是对话助手的记忆索引引擎。

你的任务是把可见的用户/助手对话转换为持久记忆索引。

规则：
- 只能使用对话中明确出现的信息。
- 忽略系统提示词、工具脚手架、隐藏推理、格式噪声和运行过程闲聊。
- 保守判断。如果内容存在歧义，就省略它。
- 只有当某个主题看起来是真实的持续工作、任务流、研究主题、实施工作或值得以后再次回顾的重复问题时，才将其作为项目跟踪。
- 此处“项目”的含义较宽，可以是工作流、投稿、研究工作、健康/问题线索，或用户可能反复讨论的其他持续主题。
- 如果对话包含多个相互独立的持续主题，返回多个 project 项，不要合并成一个。
- 当用户正在持续处理照护、疾病应对、症状追踪、康复随访或其他现实问题时，应将这些重复的问题解决线索视为项目。
- 示例：“朋友腹泻 / 用户购买药物 / 后续反馈康复”是一条项目型线索。
- 示例：“准备 EMNLP 投稿”是另一条独立的项目型线索。
- 不要把随口提及的一次性内容视为项目。
- 只提取可能影响未来对话的事实：偏好、约束、目标、身份、长期上下文、稳定关系或持久项目上下文。
- 这些事实是后续全局画像重写的中间材料，因此应优先保留稳定事实，而不是临时情境记录。
- 自然语言输出字段必须使用用户消息中的主要语言。如果用户消息混合多种语言，优先采用最近一条用户消息的语言。键名和枚举值必须保持英文。
- 每个项目摘要必须是紧凑的 1 至 2 句项目记忆，不能只是通用状态句。
- 良好的项目摘要应尽量保留：项目是什么、当前处于什么阶段，以及可用时的后续步骤、阻塞或缺失信息。
- 不要输出“用户正在做这个项目”“进展顺利”“情况还好”或“正在处理某事”之类含糊摘要，除非同时包含项目特定上下文。
- latest_progress 必须简短，只记录最新的有意义进展、最新阻塞或最新确认状态。
- 只返回有效 JSON，不要使用 Markdown 代码围栏，也不要附加说明。

严格使用以下 JSON 结构：
{
  "summary": "简短的会话摘要",
  "situation_time_info": "简短且包含时间语境的进展说明",
  "facts": [
    {
      "category": "preference | profile | goal | constraint | relationship | project | context | other",
      "subject": "稳定的英文键名片段",
      "value": "持久事实文本",
      "confidence": 0.0
    }
  ],
  "projects": [
    {
      "key": "稳定的英文标识符，使用 lower-kebab-case",
      "name": "用户能够识别的项目名称",
      "status": "planned | in_progress | done",
      "summary": "滚动更新的 1 至 2 句摘要：项目是什么 + 当前阶段 + 已知时的后续步骤/阻塞",
      "latest_progress": "简短的最新有效进展或阻塞，不重复完整项目背景",
      "confidence": 0.0
    }
  ]
}
`.trim();

export const USER_PROFILE_REWRITE_SYSTEM_PROMPT = `
你负责重写对话记忆系统中的全局用户画像。
画像包含两个部分，每个部分都应在对应字段中使用 Markdown 项目符号列表书写。

规则：
- 只返回 JSON。
- existing profile markdown 是上一版画像，incoming user notes 是最新证据。
- 从头重写每个部分。不要盲目追加，也不要保留近似重复的事实。
- 如果旧画像与更新、更明确的证据冲突，优先采用新证据。
- 只保留应跨未来会话持续存在的信息。
- 不要包含项目进展、截止时间、阻塞、临时任务或项目特定的协作规则。
- 输出语言应与传入内容中的用户语言一致。
- 字段值中不要包含章节标题。
- 优先使用简洁的 Markdown 项目符号列表；某个字段没有证据时，将其省略或设为 null/空字符串。
- "identity_background_markdown"：记录用户是谁，包括姓名、机构、职务或资历、从业年限和稳定职业角色。不要放入专业方向、疾病、操作/手术、回答偏好或协作规则。
- "specialty_markdown"：记录用户的临床专业或亚专业、长期擅长的疾病和损伤类型、操作或手术专长，以及反复出现的临床场景。不要放入姓名、机构、职务、从业年限、回答偏好或协作规则。
- 回答风格、格式、交付、工作流、语言、文件和工具偏好都属于项目 Feedback，不属于全局用户画像。不要将它们放入上述任一字段。

严格使用以下 JSON 结构：
{
  "identity_background_markdown": "- ...",
  "specialty_markdown": "- ..."
}
`.trim();

const STABLE_FORMAL_PROJECT_ID_PATTERN = /^project_[a-z0-9]+$/;

const DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT = `
你是文件记忆系统的 Dream 全局审计规划器。

你的任务是检查当前项目的元数据和记忆文件，然后为该项目生成一份可直接执行的重组计划。

规则：
- 只能使用提供的当前项目元数据和记忆文件快照作为证据。
- 不要虚构所提供记忆文件不支持的项目、文件、事实或合并关系。
- 当前运行时的活动工作区只有一个顶层当前项目。
- 不要创建额外的同级项目、临时项目或上位总括项目。
- 在执行任何重写之前，先确定当前项目最终的文件级组织结构。
- 自然语言输出字段必须跟随所提供记录和项目元数据中的主要语言。
- 如果证据主要是中文，summary、project_name、description 及其他自然语言输出都使用中文。
- 键名和枚举值必须保持英文。
- 当前项目下存在多个 Project/*.md 和 Feedback/*.md 文件是预期且正确的。
- 如果记忆中出现两个明确项目名，除非证据清楚表明其中之一是应删除的无关噪声，否则将它们视为同一当前项目中的别名、阶段名或主题标签。
- 你可以：
  - 重写当前项目元数据
  - 合并当前项目内的冗余文件
  - 当文件代表当前项目内不同的持久记忆时保留多个文件
  - 仅当旧文件的持久内容已被其他位置完整吸收时删除旧文件
- 如果合并同一当前项目中使用不同项目标签的文件，project_name 必须保持用户可识别。
- 每个 retained entry id 必须且只能出现在一个输出项目中。
- deleted_entry_ids 只能包含冗余、已被取代或已被其他重写文件吸收的文件。
- 当前项目模式下 deleted_project_ids 必须保持为空。
- 项目名称必须保持用户可识别。
- 只返回有效 JSON。

严格使用以下 JSON 结构：
{
  "summary": "简短的审计摘要",
  "duplicate_topic_count": 0,
  "conflict_topic_count": 0,
  "projects": [
    {
      "plan_key": "规划器内部使用的稳定键",
      "target_project_id": "current_project",
      "project_name": "最终项目名称",
      "description": "最终项目描述",
      "status": "active",
      "merge_reason": "",
      "evidence_entry_ids": ["Project/current-stage.md"],
      "retained_entry_ids": ["Project/foo.md", "Feedback/bar.md"]
    }
  ],
  "deleted_project_ids": [],
  "deleted_entry_ids": ["Feedback/old.md"]
}
`.trim();

const DREAM_FILE_PROJECT_REWRITE_SYSTEM_PROMPT = `
你是文件记忆系统的 Dream 项目重写引擎。

你的任务是根据提供的 project 与 feedback 记忆文件，重写一个最终项目。

规则：
- 只能使用提供的记录作为证据。
- 不要创建项目级汇总文件。
- 保持原子化记忆粒度：输出少量 project 文件和 feedback 文件。
- 只有当文件明显冗余，或冲突程度足以说明合并成一个更清晰文件更好时，才进行合并。
- 保持给定的最终项目边界和最终项目名称。不要将其扩大成更抽象的上位总括项目。
- 自然语言输出字段必须跟随所提供记录和当前项目元数据中的主要语言。
- 如果证据主要是中文，project_meta 字段以及所有 project/feedback 正文字段都使用中文。
- 键名和枚举值必须保持英文。
- project 文件必须描述项目状态：stage、decisions、constraints、next_steps、blockers、timeline、notes。
- feedback 文件必须描述协作规则：rule、why、how_to_apply、notes。
- deleted_entry_ids 只能包含已被重写文件完整吸收或本身冗余的源文件。
- 每个重写文件必须引用至少一个来自所提供记录的 source_entry_id。
- 只返回有效 JSON。

严格使用以下 JSON 结构：
{
  "summary": "简短的重写摘要",
  "project_meta": {
    "project_name": "最终项目名称",
    "description": "最终项目描述",
    "status": "active"
  },
  "files": [
    {
      "type": "project",
      "name": "current-stage",
      "description": "当前项目状态",
      "source_entry_ids": ["Project/a.md"],
      "stage": "当前阶段",
      "decisions": ["决策"],
      "constraints": ["约束"],
      "next_steps": ["后续步骤"],
      "blockers": ["阻塞"],
      "timeline": ["时间线条目"],
      "notes": ["备注"]
    },
    {
      "type": "feedback",
      "name": "delivery-rule",
      "description": "交付偏好",
      "source_entry_ids": ["Feedback/b.md"],
      "rule": "规则内容",
      "why": "该规则为什么重要",
      "how_to_apply": "何时应用该规则",
      "notes": ["备注"]
    }
  ],
  "deleted_entry_ids": ["Project/obsolete.md"]
}
`.trim();

const GENERAL_PROJECT_META_MERGE_SYSTEM_PROMPT = `
你是文件记忆系统中 General Dream 的项目元数据合并规划器。

你的任务是检查所有 General 项目元数据记录，判断哪些项目节点明确描述的是同一个真实项目。

规则：
- 只能使用提供的项目元数据记录作为证据。
- 保守判断。只要存在有意义的不确定性，就不要合并。
- 仅当多个项目元数据明确指向同一个真实项目、同一持续工作流、同一外部镜像项目身份，或同一项目的明显别名/改名时，才进行合并。
- 不要仅仅因为项目共享领域、平台、客户类型、内容格式、日期、模型、工作流或宽泛业务类别就进行合并。
- 不要合并名称不同且目标或交付物不同的独立工作流。
- 示例：“GBX-A 20260423 HoneydewPulse”和“GBX-B 20260423 ClinicFlow”必须保持分离，因为它们是目标不同的两个项目。
- 对于外部镜像，source_workspace_path 与 source_project_id 同时匹配是支持合并的强证据。
- keeper_project_id 和每个 duplicate_project_id 都必须是提供的项目 ID 之一。
- 一个项目 ID 最多只能出现在一个合并组中。
- keeper 不得出现在 duplicate_project_ids 中。
- 没有明确合并依据时，返回空的 merge_groups 数组。
- 自然语言输出字段应跟随所提供项目元数据中的主要语言。
- 只返回有效 JSON。

严格使用以下 JSON 结构：
{
  "summary": "简短的合并规划摘要",
  "merge_groups": [
    {
      "keeper_project_id": "要保留的项目 ID",
      "duplicate_project_ids": ["要合并到 keeper 的项目 ID"],
      "reason": "这些元数据属于同一真实项目的具体证据"
    }
  ]
}
`.trim();

function buildDreamClusterPlanSystemPrompt(kind: "project" | "feedback"): string {
  const kindLabel = kind === "project" ? "Project" : "Feedback";
  const categoryDescription = kind === "project"
    ? "Project 记忆文件记录持久的项目事实，例如项目定义、范围、目标、阻塞、风险和重要进展。"
    : "Feedback 记忆文件记录持久的协作规则、交付规则、风格规则、标题/正文模板规则和已确认的输出约束。";
  return `
你是文件记忆系统的 ${kindLabel} Dream 聚类规划器。

你的任务是仅检查轻量级头部信息，并判断哪些文件应放在一起精炼。

规则：
- 只能使用提供的头部元数据作为证据。
- 不要假设头部信息之外的完整文件内容。
- ${categoryDescription}
- 只返回彼此互斥的候选聚类。
- 一个文件最多只能出现在一个聚类中。
- 只有当至少两个文件很可能存在重叠、冲突，或应合并为一个更清晰的记忆文件时，才创建聚类。
- 如果文件内容彼此独立且应保持分离，就不要把它们放入任何聚类。
- 文件属于同一个当前项目，本身不能作为合并理由。
- 共享工作区、共享项目归属、共享领域或共享主题都不足以支持合并，除非头部明确体现具体的语义重叠、事实冲突、规则重复或明显的整合价值。
- 每个聚类的 reason 必须指出支持精炼的具体重叠、冲突、重复规则、重复事实或整合主题。
- reason 保持简短、具体。
- 自然语言输出应跟随所提供头部中已经可见的主要语言。
- 只返回有效 JSON。

严格使用以下 JSON 结构：
{
  "summary": "简短的规划摘要",
  "clusters": [
    {
      "member_relative_paths": ["Project/a.md", "Project/b.md"],
      "reason": "为什么这些文件应放在一起精炼"
    }
  ]
}
`.trim();
}

function buildDreamClusterRefineSystemPrompt(kind: "project" | "feedback"): string {
  const kindLabel = kind === "project" ? "Project" : "Feedback";
  const categoryInstruction = kind === "project"
    ? [
        "必须且只能生成一个 project 记忆文件。",
        "只保留持久的项目事实：项目是什么、稳定范围、目标、重要进展、阻塞、风险和重要决策。",
        "不要把文件简化成含糊的状态句。",
        "适合时优先使用可读的 Markdown 标题，例如：## 摘要、## 当前阶段、## 约束、## 阻塞、## 后续步骤、## 时间线、## 备注。",
      ].join("\n- ")
    : [
        "必须且只能生成一个 feedback 记忆文件。",
        "只保留持久的协作规则：交付顺序、输出结构、风格约束、标题/正文模板指导和已确认的审阅偏好。",
        "适合时优先使用可读的 Markdown 标题，例如：## 规则、## 原因、## 应用方式、## 备注。",
      ].join("\n- ");
  return `
你是文件记忆系统的 ${kindLabel} Dream 精炼引擎。

你的任务是把一组现有记忆文件合并成且仅合并成一个更清晰的记忆文件。

规则：
- 只能使用提供的完整文件内容作为证据。
- 解决内容重叠、去除重复细节，并保留最有用的持久事实。
- 不要虚构新事实。
- 必须且只能输出一个精炼后的文件。
- 可见输出的语言必须跟随所提供文件中已有的主要语言。如果文件混合使用多种语言，采用该聚类中的主要语言。
- 标题/name、description、Markdown 标题和 Markdown 正文都必须一致遵循该语言规则。
- ${categoryInstruction}
- 只返回有效 JSON。

严格使用以下 JSON 结构：
{
  "summary": "简短的精炼摘要",
  "name": "精炼后的文件标题",
  "description": "单行描述",
  "markdown": "完整的 Markdown 正文"
}
`.trim();
}

const DREAM_PROJECT_META_REVIEW_SYSTEM_PROMPT = `
你是文件记忆系统的 Dream 项目元数据审查器。

你的任务是判断 project/feedback 精炼完成后，当前项目元数据是否明确错误或已经过时。

规则：
- 只能使用提供的当前元数据和最近的 project/feedback 文件作为证据。
- 保守判断。除非提供的证据明确支持修改，否则保留当前元数据。
- 只能更新：
  - project_name
  - description
  - status
- 不要仅为了换一种说法而重写元数据。
- 自然语言输出字段必须跟随所提供 project/feedback 文件中的主要语言。
- 只返回有效 JSON。

严格使用以下 JSON 结构：
{
  "should_update": false,
  "reason": "为什么应该或不应该修改元数据",
  "project_name": "最终项目名称",
  "description": "最终描述",
  "status": "in_progress"
}
`.trim();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sanitizeHeaders(headers: unknown): ProviderHeaders {
  if (!isRecord(headers)) return undefined;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.trim()) next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function parseModelRef(modelRef: string | undefined, config: Record<string, unknown>): { provider: string; model: string } | undefined {
  if (typeof modelRef === "string" && modelRef.includes("/")) {
    const [provider, ...rest] = modelRef.split("/");
    const model = rest.join("/").trim();
    if (provider?.trim() && model) {
      return { provider: provider.trim(), model };
    }
  }

  const modelsConfig = isRecord(config.models) ? config.models : undefined;
  const providers = modelsConfig && isRecord(modelsConfig.providers) ? modelsConfig.providers : undefined;
  if (!providers) return undefined;

  if (typeof modelRef === "string" && modelRef.trim()) {
    const providerEntries = Object.entries(providers);
    if (providerEntries.length === 1) {
      return { provider: providerEntries[0]![0], model: modelRef.trim() };
    }
  }

  for (const [provider, providerConfig] of Object.entries(providers)) {
    if (!isRecord(providerConfig)) continue;
    const models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
    const firstModel = models.find((entry) => isRecord(entry) && typeof entry.id === "string" && entry.id.trim());
    if (firstModel && isRecord(firstModel)) {
      return { provider, model: String(firstModel.id).trim() };
    }
  }
  return undefined;
}

function resolveAgentPrimaryModel(config: Record<string, unknown>, agentId?: string): string | undefined {
  const agents = isRecord(config.agents) ? config.agents : undefined;
  const defaults = agents && isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsModel = defaults && isRecord(defaults.model) ? defaults.model : undefined;

  if (agentId && agents && isRecord(agents[agentId])) {
    const agentConfig = agents[agentId] as Record<string, unknown>;
    const agentModel = isRecord(agentConfig.model) ? agentConfig.model : undefined;
    if (typeof agentModel?.primary === "string" && agentModel.primary.trim()) {
      return agentModel.primary.trim();
    }
  }

  if (typeof defaultsModel?.primary === "string" && defaultsModel.primary.trim()) {
    return defaultsModel.primary.trim();
  }

  return undefined;
}

function detectPreferredOutputLanguage(messages: MemoryMessage[]): string | undefined {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  if (/[\u4e00-\u9fff]/.test(userText)) return "Simplified Chinese";
  return undefined;
}

function buildUserProfileRewritePrompt(input: {
  existingProfile: MemoryUserSummary | null;
  candidates: MemoryCandidate[];
}): string {
  return JSON.stringify({
    existing_profile_markdown: input.existingProfile?.files[0]?.content
      ? truncate(input.existingProfile.files[0].content, 3_200)
      : null,
    incoming_user_notes: input.candidates.map((candidate) => {
      const noteMarkdown = candidate.body || candidate.profile || candidate.summary || candidate.description;
      return {
        description: truncateForPrompt(candidate.description, 180),
        note_markdown: truncate(String(noteMarkdown || ""), 1_400),
        captured_at: candidate.capturedAt ?? "",
        source_session_key: candidate.sourceSessionKey ?? "",
      };
    }),
  }, null, 2);
}

function renderIdentityBackgroundMarkdownFromItems(items: string[]): string {
  const normalized = uniqueStrings(items.map((item) => stripMarkdownSyntax(item)), 20);
  return normalized.map((item) => `- ${item}`).join("\n");
}

function normalizeSectionMarkdown(value: unknown, headingPattern: RegExp): string {
  if (typeof value !== "string") {
    if (Array.isArray(value)) {
      return renderIdentityBackgroundMarkdownFromItems(
        value.filter((item): item is string => typeof item === "string"),
      ).trim();
    }
    return "";
  }
  let normalized = value
    .replace(/\r/g, "\n")
    .replace(/^```(?:markdown)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  normalized = normalized.replace(headingPattern, "").trim();
  return normalized;
}

/**
 * Build the full profile body markdown from the identity and specialty sections.
 * PHI redaction is applied to the assembled body before returning.
 * Returns null when all sections are empty (nothing to write to disk).
 */
export function buildUserProfileBodyFromParsedSections(payload: RawUserProfilePayload): string | null {
  const identityContent = normalizeSectionMarkdown(
    payload.identity_background_markdown ?? payload.identity_background,
    /^#{1,6}\s*身份背景\s*\n+/i,
  );
  const specialtyContent = normalizeSectionMarkdown(
    payload.specialty_markdown,
    /^#{1,6}\s*专业领域\s*\n+/i,
  );
  const sections: string[] = [];
  if (identityContent) sections.push(`## 身份背景\n${identityContent}\n`);
  if (specialtyContent) sections.push(`## 专业领域\n${specialtyContent}\n`);

  if (sections.length === 0) return null;

  const { text: redacted } = redact(sections.join("\n"));
  return redacted;
}

function extractIdentityBackgroundFactsFromProfileBody(body: string): string[] {
  return splitProfileFacts(stripMarkdownSyntax(body));
}

function buildRewrittenUserProfileCandidate(input: {
  payload: RawUserProfilePayload;
  latestCandidate?: MemoryCandidate;
}): MemoryCandidate | null {
  const body = buildUserProfileBodyFromParsedSections(input.payload);
  if (!body) return null;

  const facts = extractIdentityBackgroundFactsFromProfileBody(body);
  return {
    type: "user",
    scope: "global",
    name: "user-profile",
    description: truncateForPrompt(facts[0] || "User profile", 120),
    ...(input.latestCandidate?.capturedAt ? { capturedAt: input.latestCandidate.capturedAt } : {}),
    ...(input.latestCandidate?.sourceSessionKey ? { sourceSessionKey: input.latestCandidate.sourceSessionKey } : {}),
    body,
    ...(facts.length > 0 ? { profile: facts.join("；") } : {}),
    ...(facts.length > 0 ? { relationships: facts } : {}),
  };
}

function buildConversationTurns(messages: MemoryMessage[]): MemoryMessage[][] {
  const turns: MemoryMessage[][] = [];
  let current: MemoryMessage[] = [];
  for (const message of messages.filter((item) => item.role === "user" || item.role === "assistant")) {
    if (message.role === "user") {
      if (current.length > 0) turns.push(current);
      current = [message];
      continue;
    }
    if (current.length > 0) current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function findFocusTurnIndex(turns: MemoryMessage[][], focusMessage: MemoryMessage): number {
  const byReference = turns.findIndex((turn) => turn.some((message) => message === focusMessage));
  if (byReference >= 0) return byReference;
  const byValue = turns.findIndex((turn) =>
    turn.some((message) => message.role === focusMessage.role && message.content === focusMessage.content));
  return byValue;
}

function serializeTurnsForPrompt(turns: MemoryMessage[][]): Array<{ turn_index: number; messages: Array<{ role: string; content: string }> }> {
  return turns.map((turn, index) => ({
    turn_index: index + 1,
    messages: turn.map((message) => ({
      role: message.role,
      content: truncateForPrompt(message.content, 320),
    })),
  }));
}

function buildIndexPromptWindow(input: {
  batchContextMessages: MemoryMessage[];
  focusUserTurn: MemoryMessage;
  currentProjectMeta?: ProjectMetaRecord | null;
}): string {
  const turns = buildConversationTurns(input.batchContextMessages);
  const focusTurnIndex = findFocusTurnIndex(turns, input.focusUserTurn);
  const focusTurn = focusTurnIndex >= 0
    ? turns[focusTurnIndex]!
    : [input.focusUserTurn];
  const previousTurns = focusTurnIndex >= 0
    ? turns.slice(Math.max(0, focusTurnIndex - 2), focusTurnIndex)
    : [];
  const nextTurns = focusTurnIndex >= 0
    ? turns.slice(focusTurnIndex + 1, focusTurnIndex + 3)
    : [];
  return JSON.stringify({
    current_project_meta: input.currentProjectMeta
      ? {
          project_id: input.currentProjectMeta.projectId,
          project_name: input.currentProjectMeta.projectName,
          description: truncateForPrompt(input.currentProjectMeta.description, 220),
          status: input.currentProjectMeta.status,
          updated_at: input.currentProjectMeta.updatedAt,
        }
      : null,
    focus_user_turn: {
      role: input.focusUserTurn.role,
      content: truncateForPrompt(input.focusUserTurn.content, 400),
    },
    focus_turn_with_neighbor_assistant_context: serializeTurnsForPrompt([focusTurn])[0],
    previous_turns: serializeTurnsForPrompt(previousTurns),
    next_turns: serializeTurnsForPrompt(nextTurns),
  }, null, 2);
}

function normalizeClassificationLabels(value: unknown): MemoryClassificationLabel[] {
  if (!Array.isArray(value)) return [];
  const labels: MemoryClassificationLabel[] = [];
  const seen = new Set<MemoryCreateKind>();
  for (const item of value) {
    const record = isRecord(item) ? item as RawMemoryClassificationLabelPayload : undefined;
    const type = record?.type === "user" || record?.type === "project" || record?.type === "feedback"
      ? record.type
      : undefined;
    if (!type || seen.has(type)) continue;
    seen.add(type);
    labels.push({
      type,
      reason: typeof record?.reason === "string" ? truncateForPrompt(record.reason, 220) : "",
      evidence: typeof record?.evidence === "string" ? truncateForPrompt(record.evidence, 220) : "",
    });
  }
  return labels;
}

function buildCandidateFromCreatePayload(input: {
  kind: MemoryCreateKind;
  payload: RawMemoryCreatePayload;
  timestamp: string;
  sessionKey?: string;
}): MemoryCandidate | null {
  const name = typeof input.payload.name === "string" ? truncateForPrompt(input.payload.name, 80) : "";
  const description = typeof input.payload.description === "string"
    ? truncateForPrompt(input.payload.description, 180)
    : "";
  const markdown = typeof input.payload.markdown === "string" ? input.payload.markdown.trim() : "";
  if (!name || !description || !markdown) return null;
  if (input.kind === "project" && isGenericProjectCandidateName(name)) return null;
  return {
    type: input.kind,
    scope: input.kind === "user" ? "global" : "project",
    name,
    description,
    body: markdown,
    capturedAt: input.timestamp,
    ...(input.sessionKey ? { sourceSessionKey: input.sessionKey } : {}),
  };
}

function buildDreamFileGlobalPlanPrompt(input: LlmDreamFileGlobalPlanInput): string {
  const currentProjectNames = Array.from(new Set(
    input.currentProjects
      .map((project) => normalizeWhitespace(project.projectName))
      .filter(Boolean),
  ));
  const observedMemoryLabels = Array.from(new Set(
    input.records
      .filter((record) => record.type === "project")
      .map((record) => normalizeWhitespace(record.name))
      .filter(Boolean),
  ));
  return JSON.stringify({
    governance_scope: {
      mode: "dream_file_global_plan",
      workspace_mode: "current_project",
      primary_truth: "existing_file_memories_only",
      writable_targets: ["project.meta.md", "Project/*.md", "Feedback/*.md"],
      forbidden_outputs: ["new project-level summary file", "new summary layer"],
    },
    merge_constraints: {
      current_project_names: currentProjectNames,
      observed_memory_labels: observedMemoryLabels,
      keep_multiple_memory_files_within_current_project: true,
      do_not_create_additional_top_level_projects: true,
    },
    current_projects: input.currentProjects.map((project) => ({
      project_id: project.projectId,
      project_name: project.projectName,
      description: truncateForPrompt(project.description, 220),
      status: project.status,
      updated_at: project.updatedAt,
      dream_updated_at: project.dreamUpdatedAt ?? "",
    })),
    records: input.records.map((record) => ({
      entry_id: record.entryId,
      relative_path: record.relativePath,
      type: record.type,
      scope: record.scope,
      project_id: record.projectId ?? "",
      is_tmp: record.isTmp,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      updated_at: record.updatedAt,
      captured_at: record.capturedAt ?? "",
      source_session_key: record.sourceSessionKey ?? "",
      content: truncateForPrompt(record.content, 1200),
      project: record.project
        ? {
            stage: truncateForPrompt(record.project.stage, 220),
            decisions: record.project.decisions.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            constraints: record.project.constraints.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            next_steps: record.project.nextSteps.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            blockers: record.project.blockers.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            timeline: record.project.timeline.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            notes: record.project.notes.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
          }
        : undefined,
      feedback: record.feedback
        ? {
            rule: truncateForPrompt(record.feedback.rule, 220),
            why: truncateForPrompt(record.feedback.why, 220),
            how_to_apply: truncateForPrompt(record.feedback.howToApply, 220),
            notes: record.feedback.notes.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
          }
        : undefined,
    })),
  }, null, 2);
}

function buildDreamFileProjectRewritePrompt(input: LlmDreamFileProjectRewriteInput): string {
  return JSON.stringify({
    governance_scope: {
      mode: "dream_file_project_rewrite",
      primary_truth: "supplied_project_and_feedback_files",
      forbidden_outputs: ["new project-level summary file", "new summary layer"],
      final_project_id: input.project.projectId,
    },
    project: {
      project_id: input.project.projectId,
      plan_key: input.project.planKey,
      project_name: input.project.projectName,
      description: truncateForPrompt(input.project.description, 220),
      status: input.project.status,
      merge_reason: input.project.mergeReason ?? "",
      evidence_entry_ids: input.project.evidenceEntryIds,
      retained_entry_ids: input.project.retainedEntryIds,
    },
    current_meta: input.currentMeta
      ? {
          project_id: input.currentMeta.projectId,
          project_name: input.currentMeta.projectName,
          description: truncateForPrompt(input.currentMeta.description, 220),
          status: input.currentMeta.status,
          updated_at: input.currentMeta.updatedAt,
        }
      : null,
    records: input.records.map((record) => ({
      entry_id: record.entryId,
      relative_path: record.relativePath,
      type: record.type,
      is_tmp: record.isTmp,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      content: truncateForPrompt(record.content, 1200),
      project: record.project
        ? {
            stage: truncateForPrompt(record.project.stage, 220),
            decisions: record.project.decisions.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            constraints: record.project.constraints.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            next_steps: record.project.nextSteps.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            blockers: record.project.blockers.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            timeline: record.project.timeline.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            notes: record.project.notes.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
          }
        : undefined,
      feedback: record.feedback
        ? {
            rule: truncateForPrompt(record.feedback.rule, 220),
            why: truncateForPrompt(record.feedback.why, 220),
            how_to_apply: truncateForPrompt(record.feedback.howToApply, 220),
            notes: record.feedback.notes.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
          }
        : undefined,
    })),
  }, null, 2);
}

function buildDreamClusterPlanPrompt(input: LlmDreamClusterPlanInput): string {
  return JSON.stringify({
    category: input.kind,
    headers: input.headers.map((header) => ({
      relative_path: header.relativePath,
      name: truncateForPrompt(header.name, 120),
      description: truncateForPrompt(header.description, 220),
      updated_at: header.updatedAt,
    })),
  }, null, 2);
}

function buildDreamClusterRefinePrompt(input: LlmDreamClusterRefineInput): string {
  return JSON.stringify({
    category: input.kind,
    records: input.records.map((record) => ({
      entry_id: record.entryId,
      relative_path: record.relativePath,
      type: record.type,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      updated_at: record.updatedAt,
      captured_at: record.capturedAt ?? "",
      source_session_key: record.sourceSessionKey ?? "",
      content: record.content,
    })),
  }, null, 2);
}

function buildDreamProjectMetaReviewPrompt(input: LlmDreamProjectMetaReviewInput): string {
  return JSON.stringify({
    current_project_meta: {
      project_id: input.currentMeta.projectId,
      project_name: input.currentMeta.projectName,
      description: truncateForPrompt(input.currentMeta.description, 220),
      status: input.currentMeta.status,
      updated_at: input.currentMeta.updatedAt,
      dream_updated_at: input.currentMeta.dreamUpdatedAt ?? "",
    },
    recent_project_files: input.recentProjectRecords.map((record) => ({
      relative_path: record.relativePath,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      updated_at: record.updatedAt,
      content: record.content,
    })),
    recent_feedback_files: input.recentFeedbackRecords.map((record) => ({
      relative_path: record.relativePath,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      updated_at: record.updatedAt,
      content: record.content,
    })),
  }, null, 2);
}

function buildGeneralProjectMetaMergePrompt(input: LlmGeneralProjectMetaMergeInput): string {
  return JSON.stringify({
    governance_scope: {
      mode: "general_project_meta_merge_plan",
      primary_truth: "supplied_general_project_meta_only",
      writable_targets: ["GeneralProjects/*.md"],
      forbidden_outputs: ["new project meta", "project memory rewrite", "feedback memory rewrite", "user profile rewrite"],
    },
    project_metas: input.projectMetas.map((project) => ({
      project_id: project.projectId,
      project_name: project.projectName,
      description: truncateForPrompt(project.description, 260),
      status: project.status,
      updated_at: project.updatedAt,
      dream_updated_at: project.dreamUpdatedAt ?? "",
      source_kind: project.sourceKind ?? "",
      source_workspace_path: project.sourceWorkspacePath ?? "",
      source_project_id: project.sourceProjectId ?? "",
    })),
  }, null, 2);
}

function extractFirstJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty extraction response");
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("No JSON object found in extraction response");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, index + 1);
    }
  }

  throw new Error("Incomplete JSON object in extraction response");
}

function extractLooseJsonEnvelope(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty extraction response");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("No JSON envelope found in extraction response");
  }
  return trimmed.slice(start, end + 1);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeLooseJsonString(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function extractLooseJsonBooleanProperty(source: string, key: string): boolean | undefined {
  const match = source.match(new RegExp(`"${escapeRegexLiteral(key)}"\\s*:\\s*(true|false)`, "i"));
  if (!match) return undefined;
  return match[1]?.toLowerCase() === "true";
}

function extractLooseJsonStringProperty(
  source: string,
  key: string,
  nextKeys: string[],
): string | undefined {
  const escapedKey = escapeRegexLiteral(key);
  const nextKeyPattern = nextKeys.map((item) => escapeRegexLiteral(item)).join("|");
  const pattern = nextKeys.length > 0
    ? new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*?)"\\s*,\\s*"(${nextKeyPattern})"\\s*:`, "i")
    : new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*)"\\s*}\\s*$`, "i");
  const match = source.match(pattern);
  return match?.[1] ? decodeLooseJsonString(match[1]) : undefined;
}

function tryParseLooseMemoryCreatePayload(raw: string): RawMemoryCreatePayload | null {
  const envelope = extractLooseJsonEnvelope(raw);
  const payload: RawMemoryCreatePayload = {
    ...(extractLooseJsonBooleanProperty(envelope, "skip") !== undefined
      ? { skip: extractLooseJsonBooleanProperty(envelope, "skip") }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "reason", ["name", "description", "markdown"])
      ? { reason: extractLooseJsonStringProperty(envelope, "reason", ["name", "description", "markdown"]) }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "name", ["description", "markdown"])
      ? { name: extractLooseJsonStringProperty(envelope, "name", ["description", "markdown"]) }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "description", ["markdown"])
      ? { description: extractLooseJsonStringProperty(envelope, "description", ["markdown"]) }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "markdown", [])
      ? { markdown: extractLooseJsonStringProperty(envelope, "markdown", []) }
      : {}),
  };
  return typeof payload.name === "string" && typeof payload.description === "string" && typeof payload.markdown === "string"
    ? payload
    : null;
}

function slugifyKeyPart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "item";
}

function clampConfidence(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeDreamFileProjectId(value: unknown, allowedProjectIds: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeWhitespace(value);
  return normalized && allowedProjectIds.has(normalized) ? normalized : undefined;
}

function normalizeDreamFileEntryIds(items: unknown, allowedEntryIds: ReadonlySet<string>, maxItems = 200): string[] {
  if (!Array.isArray(items)) return [];
  return Array.from(new Set(
    items
      .filter((item): item is string => typeof item === "string")
      .map((item) => normalizeWhitespace(item))
      .filter((item) => item && allowedEntryIds.has(item)),
  )).slice(0, maxItems);
}

function normalizeDreamFileProjectStatus(value: unknown): string {
  const normalized = typeof value === "string" ? normalizeWhitespace(value) : "";
  return truncate(normalized || "active", 80);
}

function normalizeDreamFileMergeReason(
  value: unknown,
): "rename" | "alias_equivalence" | "duplicate_formal_project" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeWhitespace(value).toLowerCase();
  switch (normalized) {
    case "rename":
    case "alias_equivalence":
    case "duplicate_formal_project":
      return normalized;
    default:
      return undefined;
  }
}

function normalizeDreamFileGlobalPlanProject(
  item: unknown,
  allowedEntryIds: ReadonlySet<string>,
  allowedProjectIds: ReadonlySet<string>,
  fallbackIndex: number,
): LlmDreamFileGlobalPlanProject | null {
  if (!isRecord(item)) return null;
  const retainedEntryIds = normalizeDreamFileEntryIds(item.retained_entry_ids, allowedEntryIds, 400);
  if (retainedEntryIds.length === 0) return null;
  const planKey = typeof item.plan_key === "string"
    ? truncate(normalizeWhitespace(item.plan_key), 120)
    : `dream-plan-${fallbackIndex + 1}`;
  const projectName = typeof item.project_name === "string"
    ? truncate(normalizeWhitespace(item.project_name), 120)
    : "";
  const description = typeof item.description === "string"
    ? truncate(normalizeWhitespace(item.description), 320)
    : "";
  if (!projectName || !description) return null;
  const targetProjectId = normalizeDreamFileProjectId(item.target_project_id, allowedProjectIds);
  const mergeReason = normalizeDreamFileMergeReason(item.merge_reason);
  return {
    planKey,
    ...(targetProjectId ? { targetProjectId } : {}),
    projectName,
    description,
    status: normalizeDreamFileProjectStatus(item.status),
    ...(mergeReason ? { mergeReason } : {}),
    evidenceEntryIds: normalizeDreamFileEntryIds(item.evidence_entry_ids, allowedEntryIds, 80),
    retainedEntryIds,
  };
}

function normalizeDreamFileProjectMetaPayload(
  value: unknown,
  fallback: { projectName: string; description: string; status: string },
): { projectName: string; description: string; status: string } {
  if (!isRecord(value)) return fallback;
  const projectName = typeof value.project_name === "string"
    ? truncate(normalizeWhitespace(value.project_name), 120)
    : fallback.projectName;
  const description = typeof value.description === "string"
    ? truncate(normalizeWhitespace(value.description), 320)
    : fallback.description;
  return {
    projectName: projectName || fallback.projectName,
    description: description || fallback.description,
    status: normalizeDreamFileProjectStatus(value.status ?? fallback.status),
  };
}

function normalizeDreamFileProjectRewriteFile(
  item: unknown,
  allowedEntryIds: ReadonlySet<string>,
): LlmDreamFileProjectRewriteOutputFile | null {
  if (!isRecord(item)) return null;
  const type = item.type === "project" || item.type === "feedback" ? item.type : null;
  if (!type) return null;
  const sourceEntryIds = normalizeDreamFileEntryIds(item.source_entry_ids, allowedEntryIds, 200);
  if (sourceEntryIds.length === 0) return null;
  const name = typeof item.name === "string" ? truncate(normalizeWhitespace(item.name), 120) : "";
  const description = typeof item.description === "string" ? truncate(normalizeWhitespace(item.description), 320) : "";
  if (!name || !description) return null;
  if (type === "project") {
    const stage = typeof item.stage === "string" ? truncate(normalizeWhitespace(item.stage), 220) : "";
    return {
      type,
      name,
      description,
      sourceEntryIds,
      ...(stage ? { stage } : {}),
      decisions: uniqueStrings(normalizeStringArray(item.decisions, 20), 20),
      constraints: uniqueStrings(normalizeStringArray(item.constraints, 20), 20),
      nextSteps: uniqueStrings(normalizeStringArray(item.next_steps, 20), 20),
      blockers: uniqueStrings(normalizeStringArray(item.blockers, 20), 20),
      timeline: uniqueStrings(normalizeStringArray(item.timeline, 20), 20),
      notes: uniqueStrings(normalizeStringArray(item.notes, 20), 20),
    };
  }
  const rule = typeof item.rule === "string" ? truncate(normalizeWhitespace(item.rule), 320) : "";
  if (!rule) return null;
  return {
    type,
    name,
    description,
    sourceEntryIds,
    rule,
    ...(typeof item.why === "string" && normalizeWhitespace(item.why)
      ? { why: truncate(normalizeWhitespace(item.why), 320) }
      : {}),
    ...(typeof item.how_to_apply === "string" && normalizeWhitespace(item.how_to_apply)
      ? { howToApply: truncate(normalizeWhitespace(item.how_to_apply), 320) }
      : {}),
    notes: uniqueStrings(normalizeStringArray(item.notes, 20), 20),
  };
}

function normalizeDreamCluster(
  item: unknown,
  allowedRelativePaths: ReadonlySet<string>,
): LlmDreamCluster | null {
  if (!isRecord(item)) return null;
  const memberRelativePaths = normalizeDreamFileEntryIds(item.member_relative_paths, allowedRelativePaths, 32);
  if (memberRelativePaths.length === 0) return null;
  const reason = typeof item.reason === "string"
    ? truncate(normalizeWhitespace(item.reason), 320)
    : "";
  return {
    memberRelativePaths,
    reason,
  };
}

function normalizeGeneralProjectMetaMergeGroup(item: unknown): LlmGeneralProjectMetaMergeGroup | null {
  if (!isRecord(item)) return null;
  const keeperProjectId = typeof item.keeper_project_id === "string"
    ? normalizeWhitespace(item.keeper_project_id)
    : "";
  const duplicateProjectIds = normalizeStringArray(item.duplicate_project_ids, 100)
    .map((projectId) => normalizeWhitespace(projectId))
    .filter(Boolean);
  if (!keeperProjectId || duplicateProjectIds.length === 0) return null;
  const reason = typeof item.reason === "string"
    ? truncate(normalizeWhitespace(item.reason), 320)
    : "";
  return {
    keeperProjectId,
    duplicateProjectIds: Array.from(new Set(duplicateProjectIds)),
    reason,
  };
}

function normalizeDreamProjectMetaReview(
  payload: RawProjectMetaReviewPayload,
  fallback: { projectName: string; description: string; status: string },
): LlmDreamProjectMetaReviewOutput {
  return {
    shouldUpdate: normalizeBoolean(payload.should_update, false),
    reason: typeof payload.reason === "string"
      ? truncate(normalizeWhitespace(payload.reason), 320)
      : "",
    projectMeta: {
      projectName: typeof payload.project_name === "string"
        ? truncate(normalizeWhitespace(payload.project_name), 120) || fallback.projectName
        : fallback.projectName,
      description: typeof payload.description === "string"
        ? truncate(normalizeWhitespace(payload.description), 320) || fallback.description
        : fallback.description,
      status: normalizeDreamFileProjectStatus(payload.status ?? fallback.status),
    },
  };
}

function truncateForPrompt(value: string, maxLength: number): string {
  return truncate(normalizeWhitespace(value), maxLength);
}

function recallProjectSourcePriority(project: ProjectShortlistCandidate): number {
  if (project.sourceType === "general_local" || project.sourceType === "workspace_external_mirror") return 2;
  if (project.sourceType === "workspace_external") return 1;
  return 0;
}

function chooseBestRecallProjectFallback(shortlist: ProjectShortlistCandidate[]): ProjectShortlistCandidate {
  return [...shortlist].sort((left, right) => {
    if (right.exact !== left.exact) return right.exact - left.exact;
    if (right.score !== left.score) return right.score - left.score;
    const sourcePriorityDelta = recallProjectSourcePriority(right) - recallProjectSourcePriority(left);
    if (sourcePriorityDelta !== 0) return sourcePriorityDelta;
    return right.updatedAt.localeCompare(left.updatedAt);
  })[0] ?? shortlist[0];
}

function normalizeStringArray(items: unknown, maxItems: number): string[] {
  if (typeof items === "string" && items.trim()) {
    return [items.trim()].slice(0, maxItems);
  }
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function uniqueStrings(items: readonly string[], maxItems: number): string[] {
  return Array.from(new Set(
    items
      .map((item) => item.trim())
      .filter(Boolean),
  )).slice(0, maxItems);
}

function pickLongest(left: string, right: string): string {
  const a = normalizeWhitespace(left);
  const b = normalizeWhitespace(right);
  if (!a) return b;
  if (!b) return a;
  return b.length >= a.length ? b : a;
}

function stripExplicitRememberLead(text: string): string {
  return normalizeWhitespace(text);
}

function splitPreferenceHints(text: string): string[] {
  const normalized = text
    .replace(/\r/g, "\n")
    .replace(/[：:]/g, "\n")
    .replace(/[；;]/g, "\n")
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  return Array.from(new Set(
    normalized
      .map((line) => stripExplicitRememberLead(line))
      .filter(Boolean)
      .filter((line) => line.length >= 4),
  )).slice(0, 10);
}

function splitProfileFacts(text: string): string[] {
  return uniqueStrings(
    text
      .replace(/\r/g, "\n")
      .split(/\n|[，,；;。.!?]/)
      .map((line) => normalizeWhitespace(line))
      .filter((line) => line.length >= 2),
    20,
  );
}

function stripMarkdownSyntax(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/\r/g, "\n")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/^\s*[-*+]\s*/gm, "")
      .replace(/`+/g, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1"),
  );
}

function isStableFormalProjectId(value: string | undefined): boolean {
  return STABLE_FORMAL_PROJECT_ID_PATTERN.test((value ?? "").trim());
}

function canonicalizeUserFact(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[，。；;,:：.!?]/g, "")
    .replace(/^技术栈常用/, "常用")
    .replace(/^主要使用/, "使用")
    .replace(/^我(?:现在)?常用/, "常用")
    .replace(/^我(?:平时)?更?习惯(?:使用)?/, "习惯")
    .replace(/^习惯(?:使用)?/, "习惯")
    .replace(/^使用/, "")
    .replace(/\s+/g, "");
}

function dedupeFactsAgainstSection(items: string[], excluded: string[]): string[] {
  const excludedKeys = new Set(excluded.map((item) => canonicalizeUserFact(item)).filter(Boolean));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of items) {
    const normalized = normalizeWhitespace(item);
    const key = canonicalizeUserFact(normalized);
    if (!normalized || !key || excludedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    next.push(normalized);
  }
  return next;
}

function normalizeUserSectionItems(value: unknown, maxItems: number): string[] {
  if (typeof value === "string") {
    return splitProfileFacts(stripMarkdownSyntax(value)).slice(0, maxItems);
  }
  return normalizeStringArray(value, maxItems);
}

function cleanUserIdentitySummary(input: {
  identityBackground: string[];
}): {
  identityBackground: string[];
} {
  return {
    identityBackground: uniqueStrings(
      input.identityBackground.flatMap((item) => splitProfileFacts(stripMarkdownSyntax(item))),
      20,
    ),
  };
}

function looksLikeCollaborationRuleText(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  return /(以后回答|回答时|回复时|同步进展|代码示例|先给结论|先说完成了什么|不要写成|怎么和我协作|怎么交付|怎么汇报|请你|交付时|汇报|review|评审|写法|输出格式|回复格式|格式化输出)/i
    .test(normalized)
    || /((给我|你|请按|每次).{0,12}(交付|输出|回复|汇报).{0,20}(标题|正文|封面文案))|((先给|再给).{0,12}(标题|正文|封面文案))/i
      .test(normalized);
}

function deriveFeedbackCandidateName(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (/(交付|标题|正文|封面文案)/i.test(normalized)) return "delivery-rule";
  if (/(汇报|同步进展|风险|完成了什么)/i.test(normalized)) return "reporting-rule";
  if (/(格式|风格|写法|回复时|回答时)/i.test(normalized)) return "format-rule";
  return "collaboration-rule";
}

function looksLikeConcreteProjectMemoryText(text: string): boolean {
  return /(目标是|当前卡点|里程碑|要出可演示版本|要给团队试用|阶段|进展|deadline|blocker|next step|版本|试用|发布|第一版|只做|先做|不碰|约束|限制|一期范围|当前范围|保留|新增一级|memory tab|当前风险|跨会话召回|project\.meta|当前 project)/i
    .test(normalizeWhitespace(text));
}

function looksLikeProjectRiskText(text: string): boolean {
  return /(当前风险|风险是|主要风险|核心风险|跨会话召回|project\.meta|当前 project|召回[^。；;\n]*project|召回[^。；;\n]*当前项目)/i
    .test(normalizeWhitespace(text));
}

function looksLikeProjectScopeText(text: string): boolean {
  return /(一期范围|当前范围|本期范围|替换旧记忆|保留[^。；;\n]*(?:memory_overview|memory_list|memory_search|memory_get|memory_flush|memory_dream)|新增一级[^。；;\n]*memory tab|新增[^。；;\n]*memory tab|memory_overview|memory_list|memory_search|memory_get|memory_flush|memory_dream)/i
    .test(normalizeWhitespace(text));
}

function looksLikeProjectFollowUpText(text: string): boolean {
  const normalized = normalizeWhitespace(stripExplicitRememberLead(text));
  if (!normalized) return false;
  return /(接下来|下一步|下个阶段|最该补|还差|先做|先把|优先|先补|最优先|当前卡点|卡点|阻塞|受众|定位|内容角度|角度|约束|限制|不要碰|别碰|统一成|模板化|目标人群|适合打给|更适合打给|核心约束|镜头顺序|标题锚点|开头三秒)/i
    .test(normalized);
}

function looksLikeProjectNextStepText(text: string): boolean {
  return /(接下来|下一步|最该补|还差|先做|先把|优先|先补|最优先)/i.test(normalizeWhitespace(text));
}

function looksLikeProjectConstraintText(text: string): boolean {
  return /(约束|限制|不要|别碰|统一成|模板化|必须|只能|先别|不碰)/i.test(normalizeWhitespace(text));
}

function looksLikeProjectBlockerText(text: string): boolean {
  return /(卡点|阻塞|难点|问题在于|麻烦是|还差)/i.test(normalizeWhitespace(text));
}

function extractUniqueBatchProjectName(messages: MemoryMessage[]): string {
  const names = new Map<string, string>();
  for (const message of messages.filter((entry) => entry.role === "user")) {
    const value = extractProjectNameHint(message.content);
    if (!value) continue;
    const key = value.toLowerCase();
    if (!names.has(key)) names.set(key, value);
  }
  return names.size === 1 ? Array.from(names.values())[0] ?? "" : "";
}

function extractProjectDescriptorHint(text: string): string {
  const patterns = [
    /(?:它|这个项目|该项目|项目)\s*是(?:一个)?\s*([^。；;\n，,]+)/i,
    /(?:这是|这会是)(?:一个)?\s*([^。；;\n，,]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1] ? normalizeWhitespace(match[1]) : "";
    if (value) return truncateForPrompt(value, 220);
  }
  return "";
}

function extractProjectStageHint(text: string): string {
  const normalized = normalizeWhitespace(stripExplicitRememberLead(text));
  if (!normalized) return "";
  const patterns = [
    /((?:目前|现在|当前)[^。；;\n，,]*?(?:设计阶段|开发阶段|测试阶段|规划阶段|调研阶段|原型阶段|实现阶段|上线阶段))/i,
    /((?:还在|正在|处于)[^。；;\n，,]*?(?:设计阶段|开发阶段|测试阶段|规划阶段|调研阶段|原型阶段|实现阶段|上线阶段))/i,
    /((?:目前|现在|当前|还在|正在|处于)[^。；;\n，,]*?(?:验证阶段|摸索阶段|试水阶段))/i,
    /((?:[^。；;\n，,]{0,24})(?:验证阶段|摸索阶段|试水阶段))/i,
    /((?:设计阶段|开发阶段|测试阶段|规划阶段|调研阶段|原型阶段|实现阶段|上线阶段))/i,
    /((?:验证阶段|摸索阶段|试水阶段))/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const value = match?.[1] ? truncateForPrompt(normalizeWhitespace(match[1]), 220) : "";
    if (value) return value;
  }
  return "";
}

function extractProjectNameHint(text: string): string {
  const patterns = [
    /(?:先叫它|先叫|叫它|叫做|项目名(?:字)?(?:先)?叫(?:做)?)\s*[“"'《]?([^。；;\n，,：:（）()]{2,80})/i,
    /项目[，, ]*(?:先)?叫(?:做)?\s*[“"'《]?([^。；;\n，,：:（）()]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1] ? normalizeWhitespace(match[1]) : "";
    if (value) return truncate(value, 80);
  }
  return "";
}

function hasGenericProjectAnchor(text: string): boolean {
  return /(?:这个项目|该项目|本项目|这个东西|这件事)/i.test(normalizeWhitespace(text));
}

function projectIdentityTerms(project: ProjectIdentityHint): string[] {
  return uniqueStrings(
    [project.projectName]
      .map((item) => normalizeWhitespace(item).toLowerCase())
      .filter((item) => item.length > 0 && item.length <= 80 && !/[。！？!?]/.test(item)),
    20,
  );
}

function selectKnownProjectHint(text: string, knownProjects: ProjectIdentityHint[]): ProjectIdentityHint | undefined {
  if (knownProjects.length === 0) return undefined;
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) return undefined;
  const exactMatches = knownProjects.filter((project) =>
    projectIdentityTerms(project).some((term) => term && normalized.includes(term)),
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }
  const projectFollowUpSignal = (
    hasGenericProjectAnchor(text)
    || looksLikeProjectFollowUpText(text)
    || looksLikeConcreteProjectMemoryText(text)
    || looksLikeProjectRiskText(text)
    || looksLikeProjectScopeText(text)
  );
  if (knownProjects.length === 1 && projectFollowUpSignal) {
    return knownProjects[0];
  }
  return undefined;
}

function isGenericProjectCandidateName(name: string): boolean {
  const normalized = normalizeWhitespace(name).toLowerCase();
  return normalized === "" || ["overview", "project", "project-item", "memory-item"].includes(normalized);
}

function isLikelyHumanReadableProjectIdentifier(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return false;
  if (isStableFormalProjectId(normalized)) return false;
  if (isGenericProjectCandidateName(normalized)) return false;
  return normalized.length >= 2 && normalized.length <= 80;
}

function extractProjectNameFromContent(content: string): string {
  const normalized = normalizeWhitespace(content);
  if (!normalized) return "";
  const patterns = [
    /(?:项目名称|项目名|名称)\s*[:：]\s*([^\n。；;，,（）()]{2,80})/i,
    /(?:项目是|项目叫|先叫)\s*[“"'《]?([^。；;\n，,：:（）()]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const value = match?.[1] ? normalizeWhitespace(match[1]) : "";
    if (value) return truncate(value, 80);
  }
  return "";
}

function sanitizeProjectDescriptionText(text: string, projectName: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return "";
  let next = normalized
    .replace(/^(?:项目名称|项目名|名称)\s*[:：]\s*/i, "")
    .replace(/^(?:项目叫|项目是|先叫)\s*/i, "");
  if (projectName) {
    const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next
      .replace(new RegExp(`^${escaped}\\s*[（(][^)）]+[)）]?[:：]?\\s*`), "")
      .replace(new RegExp(`^${escaped}[:：]?\\s*`), "");
  }
  next = next.replace(/^[：:，,。；;\s]+/, "");
  return truncateForPrompt(normalizeWhitespace(next), 180);
}

function extractTimelineHints(text: string): string[] {
  const lines = text
    .replace(/\r/g, "\n")
    .split(/\n|(?<=[。！？!?])/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  return Array.from(new Set(lines.filter((line) => /\b20\d{2}-\d{2}-\d{2}\b/.test(line)))).slice(0, 10);
}

function extractSingleHint(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  return match?.[1] ? truncateForPrompt(match[1], 220) : "";
}

function sanitizeFeedbackSectionText(value: string | undefined): string {
  const normalized = normalizeWhitespace(value ?? "");
  if (!normalized) return "";
  if ([
    /explicit project collaboration preference captured from the user/i,
    /project anchor is not formalized yet/i,
    /project-local collaboration instruction without a formal project id yet/i,
    /project-local collaboration instruction for the current project/i,
    /project-local collaboration rule rather than a standalone project memory/i,
    /follow this collaboration rule in future project replies unless the user overrides it/i,
    /apply this rule only after dream attaches it to a formal project context/i,
    /keep it in temporary project memory until dream can attach it to the right project/i,
    /apply this rule in the current project context/i,
    /keep this as current-project feedback memory/i,
  ].some((pattern) => pattern.test(normalized))) {
    return "";
  }
  return normalized;
}

function buildSyntheticProjectFollowUpCandidate(input: {
  focusText: string;
  timestamp: string;
  sessionKey?: string;
  uniqueBatchProjectName: string;
  explicitProjectName: string;
  explicitProjectDescriptor: string;
  explicitProjectStage: string;
  explicitTimeline: string[];
  explicitGoal: string;
  explicitBlocker: string;
}): MemoryCandidate | null {
  const normalizedFocus = truncateForPrompt(normalizeWhitespace(stripExplicitRememberLead(input.focusText)), 220);
  if (!normalizedFocus) return null;
  const projectName = truncateForPrompt(input.explicitProjectName || input.uniqueBatchProjectName, 80);
  if (!projectName || isGenericProjectCandidateName(projectName)) return null;
  const description = truncateForPrompt(
    input.explicitProjectDescriptor
      || input.explicitGoal
      || input.explicitProjectStage
      || normalizedFocus,
    180,
  );
  const projectScopeSignal = looksLikeProjectScopeText(normalizedFocus);
  const projectRiskSignal = looksLikeProjectRiskText(normalizedFocus);
  return {
    type: "project",
    scope: "project",
    name: projectName,
    description,
    ...(input.sessionKey ? { sourceSessionKey: input.sessionKey } : {}),
    capturedAt: input.timestamp,
    ...(input.explicitProjectStage ? { stage: input.explicitProjectStage } : {}),
    ...(projectScopeSignal ? { decisions: [normalizedFocus] } : {}),
    ...(looksLikeProjectConstraintText(normalizedFocus) ? { constraints: [normalizedFocus] } : {}),
    ...(looksLikeProjectNextStepText(normalizedFocus) ? { nextSteps: [normalizedFocus] } : {}),
    ...(input.explicitBlocker || looksLikeProjectBlockerText(normalizedFocus) || projectRiskSignal
      ? { blockers: uniqueStrings([input.explicitBlocker, normalizedFocus].filter(Boolean), 4) }
      : {}),
    ...(input.explicitTimeline.length > 0 ? { timeline: input.explicitTimeline } : {}),
    notes: projectScopeSignal || projectRiskSignal ? [] : [normalizedFocus],
  };
}

function normalizeMemoryRoute(value: unknown): MemoryRoute {
  if (value === "user" || value === "project" || value === "mix" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function uniqueById<T>(items: T[], getId: (item: T) => string): T[] {
  const seen = new Set<string>();
  const next: T[] = [];
  for (const item of items) {
    const id = getId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(item);
  }
  return next;
}

function fallbackEvidenceNote(lines: string[], fallback = ""): string {
  const normalized = lines
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .slice(0, 8);
  const joined = normalized.join("\n");
  return truncate(joined || normalizeWhitespace(fallback), 800);
}

function extractChatCompletionsText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("Invalid chat completions payload");
  }
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error("Missing chat completion message");
  }
  const content = firstChoice.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  throw new Error("Unsupported chat completion content shape");
}

function extractResponsesText(payload: unknown): string {
  if (!isRecord(payload)) throw new Error("Invalid responses payload");
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  if (!Array.isArray(payload.output)) throw new Error("Responses payload missing output");

  const chunks: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && typeof part.text === "string") chunks.push(part.text);
    }
  }
  const text = chunks.join("\n").trim();
  if (!text) throw new Error("Responses payload did not contain text");
  return text;
}

function extractAnthropicMessagesText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new Error("Invalid Anthropic messages payload");
  }
  const text = payload.content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic messages payload did not contain text");
  return text;
}

function extractGoogleGenerateContentText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
    throw new Error("Invalid Google generateContent payload");
  }
  const chunks: string[] = [];
  for (const candidate of payload.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
    for (const part of candidate.content.parts) {
      if (isRecord(part) && typeof part.text === "string") chunks.push(part.text);
    }
  }
  const text = chunks.join("\n").trim();
  if (!text) throw new Error("Google generateContent payload did not contain text");
  return text;
}

function normalizeProviderApi(value: string): string {
  const api = value.trim().toLowerCase();
  return api === "gemini" ? "google" : api;
}

function buildGoogleGenerateContentUrl(baseUrl: string, model: string): string {
  const url = new URL(stripTrailingSlash(baseUrl));
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts.at(-1);
  const apiVersion = last === "v1" || last === "v1beta" ? last : "v1beta";
  const baseParts = last === "v1" || last === "v1beta" ? parts.slice(0, -1) : parts;
  url.pathname = `/${[
    ...baseParts,
    apiVersion,
    "models",
    `${encodeURIComponent(normalizeGoogleModelId(model))}:generateContent`,
  ].join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeGoogleModelId(model: string): string {
  const withoutProvider = model.trim().startsWith("google/") ? model.trim().slice("google/".length) : model.trim();
  if (withoutProvider === "gemini-3-pro") return "gemini-3-pro-preview";
  if (withoutProvider === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
  if (withoutProvider === "gemini-3-flash") return "gemini-3-flash-preview";
  if (withoutProvider === "gemini-3.1-flash" || withoutProvider === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  if (withoutProvider === "gemini-3.1-flash-lite") return "gemini-3.1-flash-lite-preview";
  return withoutProvider;
}

function looksLikeEnvVarName(value: string): boolean {
  return /^[A-Z0-9_]+$/.test(value);
}

type MemoryTelemetryLike = {
  trackFeatureLoopStage?: (input: Record<string, unknown>) => void;
  trackError?: (error: unknown, input?: Record<string, unknown>) => void;
};

function resolveMemoryTelemetry(runtime: Record<string, unknown> | undefined): MemoryTelemetryLike | undefined {
  const telemetry = runtime?.telemetry;
  return typeof telemetry === "object" && telemetry !== null ? telemetry as MemoryTelemetryLike : undefined;
}

function memoryPhaseFromLabel(label: string): "retrieve" | "capture" | "index" | "dream" {
  const normalized = label.toLowerCase();
  if (normalized.includes("retrieve") || normalized.includes("retrieval") || normalized.includes("recall")) return "retrieve";
  if (normalized.includes("dream") || normalized.includes("rewrite")) return "dream";
  if (normalized.includes("capture") || normalized.includes("extract")) return "capture";
  return "index";
}

export class LlmMemoryExtractor {
  private readonly prompts: MemoryPromptProfile;

  constructor(
    private readonly config: Record<string, unknown>,
    private readonly runtime: Record<string, unknown> | undefined,
    private readonly logger?: LoggerLike,
    promptProfile?: MemoryPromptProfile,
  ) {
    this.prompts = promptProfile ?? GENERAL_MEDICINE_PROFILE;
  }

  private resolveSelection(agentId?: string): ModelSelection {
    const modelRef = resolveAgentPrimaryModel(this.config, agentId);
    const parsed = parseModelRef(modelRef, this.config);
    if (!parsed) throw new Error("Could not resolve an OpenClaw model for memory extraction");

    const modelsConfig = isRecord(this.config.models) ? this.config.models : undefined;
    const providers = modelsConfig && isRecord(modelsConfig.providers) ? modelsConfig.providers : undefined;
    const providerConfig = providers && isRecord(providers[parsed.provider])
      ? providers[parsed.provider] as Record<string, unknown>
      : undefined;
    const configuredModel = Array.isArray(providerConfig?.models)
      ? providerConfig.models.find((item) => isRecord(item) && item.id === parsed.model)
      : undefined;
    const modelConfig = isRecord(configuredModel) ? configuredModel : undefined;

    const api = typeof modelConfig?.api === "string"
      ? modelConfig.api
      : typeof providerConfig?.api === "string"
        ? providerConfig.api
        : "openai-completions";
    const baseUrl = typeof modelConfig?.baseUrl === "string"
      ? modelConfig.baseUrl
      : typeof providerConfig?.baseUrl === "string"
        ? providerConfig.baseUrl
        : undefined;
    const headers = {
      ...sanitizeHeaders(providerConfig?.headers),
      ...sanitizeHeaders(modelConfig?.headers),
    };

    const selection: ModelSelection = {
      provider: parsed.provider,
      model: parsed.model,
      api,
    };
    if (baseUrl?.trim()) selection.baseUrl = stripTrailingSlash(baseUrl.trim());
    if (Object.keys(headers).length > 0) selection.headers = headers;
    return selection;
  }

  private async resolveApiKey(provider: string): Promise<string> {
    const modelsConfig = isRecord(this.config.models) ? this.config.models : undefined;
    const providers = modelsConfig && isRecord(modelsConfig.providers) ? modelsConfig.providers : undefined;
    const providerConfig = providers && isRecord(providers[provider])
      ? providers[provider] as Record<string, unknown>
      : undefined;
    const configured = typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey.trim() : "";
    if (configured) {
      if (looksLikeEnvVarName(configured) && typeof process.env[configured] === "string" && process.env[configured]?.trim()) {
        return process.env[configured]!.trim();
      }
      return configured;
    }

    const modelAuth = this.runtime && isRecord(this.runtime.modelAuth)
      ? this.runtime.modelAuth as Record<string, unknown>
      : undefined;
    const resolver = typeof modelAuth?.resolveApiKeyForProvider === "function"
      ? modelAuth.resolveApiKeyForProvider as (params: { provider: string; cfg?: Record<string, unknown> }) => Promise<{ apiKey?: string }>
      : undefined;
    if (resolver) {
      const auth = await resolver({ provider, cfg: this.config });
      if (auth?.apiKey && String(auth.apiKey).trim()) {
        return String(auth.apiKey).trim();
      }
    }

    throw new Error(`No API key resolved for extraction provider "${provider}"`);
  }

  private async callStructuredJson(input: {
    systemPrompt: string;
    userPrompt: string;
    agentId?: string;
    requestLabel: string;
    timeoutMs?: number;
  }): Promise<string> {
    const selection = this.resolveSelection(input.agentId);
    if (!selection.baseUrl) {
      throw new Error(`${input.requestLabel} provider "${selection.provider}" does not have a baseUrl`);
    }
    const telemetry = resolveMemoryTelemetry(this.runtime);
    telemetry?.trackFeatureLoopStage?.({
      module: "memory",
      ownerModule: "memory",
      executionKind: "memory",
      phase: memoryPhaseFromLabel(input.requestLabel),
      loopStage: "model_request",
      outcome: "success",
      metadata: {
        provider: selection.provider,
        model: selection.model,
        providerBaseUrl: selection.baseUrl,
        requestLabel: input.requestLabel,
      },
    });
    const apiKey = await this.resolveApiKey(selection.provider);
    const headers = new Headers(selection.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const apiType = normalizeProviderApi(selection.api);
    let url = "";
    let body: Record<string, unknown>;

    if (apiType === "openai-responses" || apiType === "responses") {
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey}`);
      url = `${selection.baseUrl}/responses`;
      body = {
        model: selection.model,
        temperature: 0,
        input: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      };
    } else if (apiType === "anthropic") {
      if (!headers.has("x-api-key")) headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
      url = `${selection.baseUrl}/v1/messages`;
      body = {
        model: selection.model,
        max_tokens: 65536,
        temperature: 0,
        system: input.systemPrompt,
        messages: [
          { role: "user", content: input.userPrompt },
        ],
      };
    } else if (apiType === "google") {
      if (!headers.has("x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
      url = buildGoogleGenerateContentUrl(selection.baseUrl, selection.model);
      body = {
        systemInstruction: { parts: [{ text: input.systemPrompt }] },
        contents: [
          { role: "user", parts: [{ text: input.userPrompt }] },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      };
    } else {
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey}`);
      url = `${selection.baseUrl}/chat/completions`;
      body = {
        model: selection.model,
        temperature: 0,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      };
    }

    const executeOnce = async (payloadBody: Record<string, unknown>): Promise<Response> => {
      const controller = new AbortController();
      const timeoutMs = resolveRequestTimeoutMs(input.timeoutMs);
      const timeoutId = timeoutMs === null ? null : setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payloadBody),
          signal: controller.signal,
        });
      } catch (error) {
        if (timeoutMs !== null && error instanceof Error && error.name === "AbortError") {
          throw new Error(`${input.requestLabel} request timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };

    const executeWithRetry = async (payloadBody: Record<string, unknown>): Promise<Response> => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < DEFAULT_REQUEST_MAX_ATTEMPTS; attempt += 1) {
        try {
          const response = await executeOnce(payloadBody);
          if (response.ok) return response;
          const errorText = await response.text();
          const error = Object.assign(
            new Error(`${input.requestLabel} request failed (${response.status}): ${truncate(errorText, 300)}`),
            { status: response.status },
          );
          lastError = error;
          if (!REQUEST_RETRYABLE_STATUS_CODES.has(response.status) || attempt >= DEFAULT_REQUEST_MAX_ATTEMPTS - 1) {
            throw error;
          }
        } catch (error) {
          lastError = error;
          if (!isTransientRequestError(error) || attempt >= DEFAULT_REQUEST_MAX_ATTEMPTS - 1) {
            throw error;
          }
        }
        await sleep(computeRetryDelayMs(attempt));
      }
      throw lastError instanceof Error ? lastError : new Error(`${input.requestLabel} request failed`);
    };

    let response: Response;
    try {
      response = await executeWithRetry(body);
    } catch (error) {
      if (!("response_format" in body)) {
        telemetry?.trackError?.(error, {
          module: "memory",
          ownerModule: "memory",
          executionKind: "memory",
          phase: memoryPhaseFromLabel(input.requestLabel),
          loopStage: "model_request",
          errorCategory: "model_request_error",
          metadata: {
            provider: selection.provider,
            model: selection.model,
            providerBaseUrl: selection.baseUrl,
          },
        });
        throw error;
      }
      const fallbackBody = { ...body };
      delete fallbackBody.response_format;
      try {
        response = await executeWithRetry(fallbackBody);
      } catch (fallbackError) {
        telemetry?.trackError?.(fallbackError, {
          module: "memory",
          ownerModule: "memory",
          executionKind: "memory",
          phase: memoryPhaseFromLabel(input.requestLabel),
          loopStage: "model_request",
          errorCategory: "model_request_error",
          metadata: {
            provider: selection.provider,
            model: selection.model,
            providerBaseUrl: selection.baseUrl,
          },
        });
        throw fallbackError;
      }
    }

    const payload = await response.json();
    telemetry?.trackFeatureLoopStage?.({
      module: "memory",
      ownerModule: "memory",
      executionKind: "memory",
      phase: memoryPhaseFromLabel(input.requestLabel),
      loopStage: "model_response",
      outcome: "success",
      metadata: {
        provider: selection.provider,
        model: selection.model,
        providerBaseUrl: selection.baseUrl,
        requestLabel: input.requestLabel,
      },
    });
    if (apiType === "openai-responses" || apiType === "responses") return extractResponsesText(payload);
    if (apiType === "anthropic") return extractAnthropicMessagesText(payload);
    if (apiType === "google") return extractGoogleGenerateContentText(payload);
    return extractChatCompletionsText(payload);
  }

  private async callStructuredJsonWithDebug<T>(input: {
    systemPrompt: string;
    userPrompt: string;
    agentId?: string;
    requestLabel: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
    parse: (raw: string) => T;
  }): Promise<T> {
    let rawResponse = "";
    try {
      rawResponse = await this.callStructuredJson(input);
      const parsedResult = input.parse(rawResponse);
      input.debugTrace?.({
        requestLabel: input.requestLabel,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        rawResponse,
        parsedResult,
      });
      return parsedResult;
    } catch (error) {
      input.debugTrace?.({
        requestLabel: input.requestLabel,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        rawResponse,
        errored: true,
        timedOut: isTimeoutError(error) || (error instanceof Error && /timed out/i.test(error.message)),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async rewriteUserProfile(input: {
    existingProfile: MemoryUserSummary | null;
    candidates: MemoryCandidate[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    const userCandidates = input.candidates.filter((candidate) => candidate.type === "user");
    if (userCandidates.length === 0) return null;

    const latestCandidate = userCandidates[userCandidates.length - 1];
    try {
      const parsed = await this.callStructuredJsonWithDebug<RawUserProfilePayload>({
        systemPrompt: USER_PROFILE_REWRITE_SYSTEM_PROMPT,
        userPrompt: buildUserProfileRewritePrompt(input),
        requestLabel: "User profile rewrite",
        timeoutMs: input.timeoutMs ?? DEFAULT_USER_PROFILE_REWRITE_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawUserProfilePayload,
      });
      return buildRewrittenUserProfileCandidate({
        payload: parsed,
        latestCandidate,
      });
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] user profile rewrite failed: ${String(error)}`);
    }

    return null;
  }

  async classifyMemoryTurn(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<FileMemoryClassificationResult> {
    try {
      const parsed = await this.callStructuredJsonWithDebug<RawMemoryClassificationPayload>({
        systemPrompt: this.prompts.classify,
        userPrompt: buildIndexPromptWindow({
          batchContextMessages: input.batchContextMessages,
          focusUserTurn: input.focusUserTurn,
          currentProjectMeta: input.currentProjectMeta,
        }),
        requestLabel: "Memory turn classification",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawMemoryClassificationPayload,
      });
      const labels = normalizeClassificationLabels(parsed.labels);
      const shouldStore = Boolean(parsed.should_store) && labels.length > 0;
      return { shouldStore, labels };
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] memory turn classification fallback: ${String(error)}`);
      return { shouldStore: false, labels: [] };
    }
  }

  private async createMemoryNote(input: {
    kind: MemoryCreateKind;
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    // Hard gate: discard note kinds not in this profile's allowedTypes.
    if (!(this.prompts.allowedTypes as ReadonlyArray<string>).includes(input.kind)) {
      this.logger?.info?.(
        `[clawxmemory] note kind "${input.kind}" is not allowed by profile "${this.prompts.type}" — discarding`,
      );
      return null;
    }
    const requestLabel = input.kind === "user"
      ? "User memory create"
      : input.kind === "project"
        ? "Project memory create"
        : "Feedback memory create";
    const systemPrompt = input.kind === "user"
      ? this.prompts.noteCreate.user!
      : input.kind === "project"
        ? this.prompts.noteCreate.project!
        : this.prompts.noteCreate.feedback;
    const userPrompt = JSON.stringify({
      classification: {
        type: input.classification.type,
        reason: input.classification.reason,
        evidence: input.classification.evidence,
      },
      context: JSON.parse(buildIndexPromptWindow({
        batchContextMessages: input.batchContextMessages,
        focusUserTurn: input.focusUserTurn,
        currentProjectMeta: input.currentProjectMeta,
      })),
    }, null, 2);

    let rawResponse = "";
    try {
      rawResponse = await this.callStructuredJson({
        systemPrompt,
        userPrompt,
        requestLabel,
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      let parsed: RawMemoryCreatePayload;
      let parseMode: "strict" | "fallback" = "strict";
      let strictParseError = "";
      try {
        parsed = JSON.parse(extractFirstJsonObject(rawResponse)) as RawMemoryCreatePayload;
      } catch (error) {
        strictParseError = error instanceof Error ? error.message : String(error);
        const fallback = tryParseLooseMemoryCreatePayload(rawResponse);
        if (!fallback) throw error;
        parsed = fallback;
        parseMode = "fallback";
      }
      input.debugTrace?.({
        requestLabel,
        systemPrompt,
        userPrompt,
        rawResponse,
        parsedResult: parseMode === "strict"
          ? parsed
          : {
              parseMode,
              strictParseError,
              payload: parsed,
            },
      });
      if (parsed.skip === true) return null;
      return buildCandidateFromCreatePayload({
        kind: input.kind,
        payload: parsed,
        timestamp: input.timestamp,
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      });
    } catch (error) {
      input.debugTrace?.({
        requestLabel,
        systemPrompt,
        userPrompt,
        rawResponse,
        errored: true,
        timedOut: isTimeoutError(error) || (error instanceof Error && /timed out/i.test(error.message)),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.logger?.warn?.(`[clawxmemory] ${requestLabel.toLowerCase()} fallback: ${String(error)}`);
      return null;
    }
  }

  async createUserMemoryNote(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    return this.createMemoryNote({ ...input, kind: "user" });
  }

  async createProjectMemoryNote(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    return this.createMemoryNote({ ...input, kind: "project" });
  }

  async createFeedbackMemoryNote(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    return this.createMemoryNote({ ...input, kind: "feedback" });
  }

  async planDreamClusters(input: LlmDreamClusterPlanInput): Promise<LlmDreamClusterPlanOutput> {
    if (input.headers.length < 2) {
      return {
        summary: `Not enough ${input.kind} files to form Dream clusters.`,
        clusters: [],
      };
    }
    const allowedRelativePaths = new Set(input.headers.map((header) => header.relativePath));
    const parsed = await this.callStructuredJsonWithDebug<RawDreamClusterPlanPayload>({
      systemPrompt: buildDreamClusterPlanSystemPrompt(input.kind),
      userPrompt: buildDreamClusterPlanPrompt(input),
      requestLabel: input.kind === "project" ? "Dream project cluster plan" : "Dream feedback cluster plan",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_CLUSTER_PLAN_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawDreamClusterPlanPayload,
    });
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : `Dream ${input.kind} cluster plan completed.`,
      clusters: Array.isArray(parsed.clusters)
        ? parsed.clusters
            .map((cluster) => normalizeDreamCluster(cluster, allowedRelativePaths))
            .filter((cluster): cluster is LlmDreamCluster => Boolean(cluster))
        : [],
    };
  }

  async refineDreamCluster(input: LlmDreamClusterRefineInput): Promise<LlmDreamClusterRefineOutput> {
    if (input.records.length === 0) {
      return {
        summary: `No ${input.kind} files were supplied for Dream refine.`,
        file: null,
      };
    }
    const parsed = await this.callStructuredJsonWithDebug<RawDreamClusterRefinePayload>({
      systemPrompt: buildDreamClusterRefineSystemPrompt(input.kind),
      userPrompt: buildDreamClusterRefinePrompt(input),
      requestLabel: input.kind === "project" ? "Dream project cluster refine" : "Dream feedback cluster refine",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_CLUSTER_REFINE_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawDreamClusterRefinePayload,
    });
    const name = typeof parsed.name === "string" ? truncate(normalizeWhitespace(parsed.name), 120) : "";
    const description = typeof parsed.description === "string" ? truncate(normalizeWhitespace(parsed.description), 320) : "";
    const markdown = typeof parsed.markdown === "string" ? parsed.markdown.trim() : "";
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : `Dream ${input.kind} cluster refine completed.`,
      file: name && description && markdown
        ? { name, description, markdown }
        : null,
    };
  }

  async planGeneralProjectMetaMerges(
    input: LlmGeneralProjectMetaMergeInput,
  ): Promise<LlmGeneralProjectMetaMergeOutput> {
    if (input.projectMetas.length < 2) {
      return {
        summary: "Fewer than two General project metadata records were available for merge planning.",
        mergeGroups: [],
      };
    }
    const parsed = await this.callStructuredJsonWithDebug<RawGeneralProjectMetaMergePlanPayload>({
      systemPrompt: GENERAL_PROJECT_META_MERGE_SYSTEM_PROMPT,
      userPrompt: buildGeneralProjectMetaMergePrompt(input),
      requestLabel: "General project meta merge plan",
      timeoutMs: input.timeoutMs ?? DEFAULT_GENERAL_PROJECT_META_MERGE_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawGeneralProjectMetaMergePlanPayload,
    });
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : "General project meta merge planning completed.",
      mergeGroups: Array.isArray(parsed.merge_groups)
        ? parsed.merge_groups
            .map((group) => normalizeGeneralProjectMetaMergeGroup(group))
            .filter((group): group is LlmGeneralProjectMetaMergeGroup => Boolean(group))
        : [],
    };
  }

  async reviewDreamProjectMeta(input: LlmDreamProjectMetaReviewInput): Promise<LlmDreamProjectMetaReviewOutput> {
    const fallback = {
      projectName: input.currentMeta.projectName,
      description: input.currentMeta.description,
      status: input.currentMeta.status,
    };
    const parsed = await this.callStructuredJsonWithDebug<RawProjectMetaReviewPayload>({
      systemPrompt: DREAM_PROJECT_META_REVIEW_SYSTEM_PROMPT,
      userPrompt: buildDreamProjectMetaReviewPrompt(input),
      requestLabel: "Dream project meta review",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_PROJECT_META_REVIEW_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawProjectMetaReviewPayload,
    });
    return normalizeDreamProjectMetaReview(parsed, fallback);
  }

  async planDreamFileMemory(input: LlmDreamFileGlobalPlanInput): Promise<LlmDreamFileGlobalPlanOutput> {
    if (input.records.length === 0) {
      return {
        summary: "No project memory files were available for Dream planning.",
        duplicateTopicCount: 0,
        conflictTopicCount: 0,
        projects: [],
        deletedProjectIds: [],
        deletedEntryIds: [],
      };
    }

    const allowedEntryIds = new Set(input.records.map((record) => record.entryId));
    const allowedProjectIds = new Set(input.currentProjects.map((project) => project.projectId));
    const parsed = await this.callStructuredJsonWithDebug<RawDreamFileGlobalPlanPayload>({
      systemPrompt: DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT,
      userPrompt: buildDreamFileGlobalPlanPrompt(input),
      requestLabel: "Dream file global plan",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_FILE_PLAN_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawDreamFileGlobalPlanPayload,
    });
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects
          .map((item, index) => normalizeDreamFileGlobalPlanProject(item, allowedEntryIds, allowedProjectIds, index))
          .filter((item): item is LlmDreamFileGlobalPlanProject => Boolean(item))
      : [];
    const deletedProjectIds = Array.from(new Set(
      normalizeStringArray(parsed.deleted_project_ids, 200)
        .map((item) => normalizeWhitespace(item))
        .filter((item) => allowedProjectIds.has(item)),
    ));
    const deletedEntryIds = normalizeDreamFileEntryIds(parsed.deleted_entry_ids, allowedEntryIds, 400);
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : "Dream file global plan completed.",
      duplicateTopicCount: Math.max(
        0,
        Math.floor(typeof parsed.duplicate_topic_count === "number" ? parsed.duplicate_topic_count : 0),
      ),
      conflictTopicCount: Math.max(
        0,
        Math.floor(typeof parsed.conflict_topic_count === "number" ? parsed.conflict_topic_count : 0),
      ),
      projects,
      deletedProjectIds,
      deletedEntryIds,
    };
  }

  async rewriteDreamFileProject(input: LlmDreamFileProjectRewriteInput): Promise<LlmDreamFileProjectRewriteOutput> {
    if (input.records.length === 0) {
      throw new Error("No memory files were supplied for Dream project rewrite.");
    }
    const allowedEntryIds = new Set(input.records.map((record) => record.entryId));
    const parsed = await this.callStructuredJsonWithDebug<RawDreamFileProjectRewritePayload>({
      systemPrompt: DREAM_FILE_PROJECT_REWRITE_SYSTEM_PROMPT,
      userPrompt: buildDreamFileProjectRewritePrompt(input),
      requestLabel: "Dream file project rewrite",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_FILE_PROJECT_REWRITE_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawDreamFileProjectRewritePayload,
    });
    const files = Array.isArray(parsed.files)
      ? parsed.files
          .map((item) => normalizeDreamFileProjectRewriteFile(item, allowedEntryIds))
          .filter((item): item is LlmDreamFileProjectRewriteOutputFile => Boolean(item))
      : [];
    const fallbackMeta = {
      projectName: input.project.projectName,
      description: input.project.description,
      status: input.project.status,
    };
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : `Dream rewrite completed for ${input.project.projectName}.`,
      projectMeta: normalizeDreamFileProjectMetaPayload(parsed.project_meta, fallbackMeta),
      files,
      deletedEntryIds: normalizeDreamFileEntryIds(parsed.deleted_entry_ids, allowedEntryIds, 400),
    };
  }

  async decideFileMemoryRoute(input: {
    query: string;
    recentMessages?: MemoryMessage[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryRoute> {
    try {
      const parsed = await this.callStructuredJsonWithDebug<{ route?: unknown }>({
        systemPrompt: [
          "You decide whether the current query should trigger long-term memory recall.",
          "Return JSON only with a single field route.",
          "Valid route values: none, user, project, mix.",
          "Use none unless the query clearly needs long-term memory.",
          "Use user only when the query is asking about stable personal identity/background facts about who the user is, such as name, profession, long-term role context, life background, or durable relationships.",
          "Do not use user for reply preferences, language choices, formatting rules, style guidance, file/tool boundaries, or delivery rules; those belong to project.",
          "Use project when the query only needs current project memory, including project facts, collaboration rules, delivery style, file boundaries, or project status.",
          "Use mix only when the query genuinely needs both current project memory and the user's stable identity/background at the same time.",
          "Do not use mix just because both could be helpful; choose mix only when both are actually necessary to answer well.",
        ].join("\n"),
        userPrompt: JSON.stringify({
          query: input.query,
          recent_messages: (input.recentMessages ?? []).slice(-4).map((message) => ({
            role: message.role,
            content: truncateForPrompt(message.content, 220),
          })),
        }, null, 2),
        requestLabel: "File memory gate",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_GATE_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as { route?: unknown },
      });
      return normalizeMemoryRoute(parsed.route) || "none";
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory gate fallback: ${String(error)}`);
      return "none";
    }
  }

  async selectRecallProject(input: {
    query: string;
    recentUserMessages?: MemoryMessage[];
    shortlist: ProjectShortlistCandidate[];
    allowEmpty?: boolean;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<{ projectId?: string; reason?: string }> {
    if (input.shortlist.length === 0) return {};
    const fallbackProject = chooseBestRecallProjectFallback(input.shortlist);
    const allowEmpty = Boolean(input.allowEmpty);
    try {
      const parsed = await this.callStructuredJsonWithDebug<{ selected_project_id?: unknown; reason?: unknown }>({
        systemPrompt: [
          allowEmpty
            ? "You choose the most relevant existing formal project for long-term memory recall only when one clearly matches the current query."
            : "You choose the single most relevant formal project for long-term memory recall.",
          "Return JSON only with selected_project_id and reason.",
          allowEmpty
            ? "Select at most one project from the provided shortlist."
            : "You must select exactly one project from the provided shortlist.",
          "Use the current query first, then recent user messages only for continuation/disambiguation.",
          "Do not infer a project from assistant wording.",
          "Similar project names are distinct by default; shared domain, shared workflow, or shared feedback do not make them the same project.",
          "If the query explicitly names one shortlist project, prefer that exact project instead of broadening to a nearby or umbrella project.",
          allowEmpty
            ? "If the current query introduces or switches to a new project that is not represented in the shortlist, return an empty selected_project_id."
            : "If the current query introduces or switches to a new project, still choose the best shortlist project.",
          allowEmpty
            ? "If no shortlist project is clearly relevant, return an empty selected_project_id."
            : "If multiple shortlist projects remain plausible, still choose the best one.",
          allowEmpty
            ? "If multiple shortlist projects are plausible but evidence is not decisive, return an empty selected_project_id."
            : "When multiple shortlist projects are plausible, never return empty; choose the best match.",
          "When relevance is comparable, prefer general_local over workspace_external.",
          allowEmpty
            ? "Use empty selected_project_id to skip project-scoped recall for a new or unrelated project; do not force unrelated memory into an existing project."
            : "Never return an empty selected_project_id when the shortlist is non-empty.",
        ].join("\n"),
        userPrompt: JSON.stringify({
          query: input.query,
          recent_user_messages: (input.recentUserMessages ?? []).slice(-4).map((message) => truncateForPrompt(message.content, 220)),
          shortlist: input.shortlist.map((project) => ({
            project_id: project.projectId,
            project_name: project.projectName,
            description: truncateForPrompt(project.description, 180),
            status: project.status,
            source_type: project.sourceType ?? "unknown",
            updated_at: project.updatedAt,
            shortlist_score: project.score,
            shortlist_exact: project.exact,
            shortlist_source: project.source,
            matched_text: truncateForPrompt(project.matchedText, 180),
          })),
        }, null, 2),
        requestLabel: "File memory project selection",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as { selected_project_id?: unknown; reason?: unknown },
      });
      const selectedProjectId = typeof parsed.selected_project_id === "string"
        ? parsed.selected_project_id.trim()
        : "";
      const matched = input.shortlist.find((project) => project.projectId === selectedProjectId);
      if (matched) {
        return {
          projectId: matched.projectId,
          ...(typeof parsed.reason === "string" && parsed.reason.trim()
            ? { reason: truncateForPrompt(parsed.reason, 220) }
            : {}),
        };
      }
      if (allowEmpty) {
        return {
          ...(typeof parsed.reason === "string" && parsed.reason.trim()
            ? { reason: truncateForPrompt(parsed.reason, 220) }
            : { reason: selectedProjectId ? "Model returned a project id outside the shortlist." : "Model returned no matching project." }),
        };
      }
      return {
        projectId: fallbackProject.projectId,
        ...(typeof parsed.reason === "string" && parsed.reason.trim()
          ? { reason: truncateForPrompt(parsed.reason, 220) }
          : { reason: `Fallback selected ${fallbackProject.projectName}; model returned no valid project id.` }),
      };
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory project selection fallback: ${String(error)}`);
      if (allowEmpty) {
        return {
          reason: "Project selection failed; no existing project was forced.",
        };
      }
      return {
        projectId: fallbackProject.projectId,
        reason: `Fallback selected ${fallbackProject.projectName}; project selection failed.`,
      };
    }
  }

  async selectIndexProject(input: {
    candidate: MemoryCandidate;
    candidatePreview: string;
    focusTurn: MemoryMessage;
    recentUserMessages?: MemoryMessage[];
    shortlist: ProjectShortlistCandidate[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<{ decision: "attach_existing" | "create_new"; projectId?: string; reason?: string }> {
    if (input.shortlist.length === 0) {
      return {
        decision: "create_new",
        reason: "No existing General projects are available for index assignment.",
      };
    }
    try {
      const parsed = await this.callStructuredJsonWithDebug<{
        decision?: unknown;
        selected_project_id?: unknown;
        reason?: unknown;
      }>({
        systemPrompt: [
          "你负责把一条新生成的长期记忆分配给某个 General Chat 项目。",
          "这是索引阶段的记忆归属判断，不是记忆召回。",
          "只返回 JSON，包含 decision、selected_project_id 和 reason。",
          "decision 必须是 attach_existing 或 create_new。",
          "主要证据是 candidate_memory_preview，即将要写入的记忆内容。",
          "焦点用户轮次和近期用户消息只能作为消除歧义的辅助上下文。",
          "只有当候选记忆明确且唯一地属于某个现有 General 项目时，才选择 attach_existing。",
          "如果候选记忆属于新项目、证据不足、仍可能对应多个项目，或仅有宽泛领域相似性，应选择 create_new。",
          "不要仅仅因为项目同属 SaaS、文案、小红书、营销、规划或内容创作等类别就进行关联。",
          "shortlist 中的所有项目都是 General 本地归属目标；绝不能推断或写入外部工作区。",
          "如果 decision 为 attach_existing，selected_project_id 必须是 shortlist 中的某个 ID。",
          "如果 decision 为 create_new，selected_project_id 必须是空字符串。",
        ].join("\n"),
        userPrompt: JSON.stringify({
          candidate: {
            type: input.candidate.type,
            name: truncateForPrompt(input.candidate.name, 120),
            description: truncateForPrompt(input.candidate.description, 220),
            rule: input.candidate.rule ? truncateForPrompt(input.candidate.rule, 220) : null,
            summary: input.candidate.summary ? truncateForPrompt(input.candidate.summary, 220) : null,
            why: input.candidate.why ? truncateForPrompt(input.candidate.why, 220) : null,
            how_to_apply: input.candidate.howToApply ? truncateForPrompt(input.candidate.howToApply, 220) : null,
            stage: input.candidate.stage ? truncateForPrompt(input.candidate.stage, 220) : null,
            decisions: (input.candidate.decisions ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            constraints: (input.candidate.constraints ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            next_steps: (input.candidate.nextSteps ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            blockers: (input.candidate.blockers ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            timeline: (input.candidate.timeline ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            notes: (input.candidate.notes ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
          },
          candidate_memory_preview: truncateForPrompt(input.candidatePreview, 1600),
          focus_user_turn: truncateForPrompt(input.focusTurn.content, 360),
          recent_user_messages: (input.recentUserMessages ?? []).slice(-4).map((message) => truncateForPrompt(message.content, 220)),
          shortlist: input.shortlist.map((project) => ({
            project_id: project.projectId,
            project_name: project.projectName,
            description: truncateForPrompt(project.description, 180),
            status: project.status,
            updated_at: project.updatedAt,
            shortlist_score: project.score,
            shortlist_exact: project.exact,
            shortlist_source: project.source,
            matched_text: truncateForPrompt(project.matchedText, 180),
          })),
        }, null, 2),
        requestLabel: "File memory project assignment",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as {
          decision?: unknown;
          selected_project_id?: unknown;
          reason?: unknown;
        },
      });
      const decision = parsed.decision === "attach_existing" ? "attach_existing" : "create_new";
      const selectedProjectId = typeof parsed.selected_project_id === "string"
        ? parsed.selected_project_id.trim()
        : "";
      const matched = input.shortlist.find((project) => project.projectId === selectedProjectId);
      const reason = typeof parsed.reason === "string" && parsed.reason.trim()
        ? truncateForPrompt(parsed.reason, 260)
        : "";
      if (decision === "attach_existing" && matched) {
        return {
          decision: "attach_existing",
          projectId: matched.projectId,
          ...(reason ? { reason } : {}),
        };
      }
      return {
        decision: "create_new",
        ...(reason
          ? { reason }
          : { reason: decision === "attach_existing" ? "Model selected an invalid project id." : "Model chose to create a new General project." }),
      };
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory project assignment fallback: ${String(error)}`);
      return {
        decision: "create_new",
        reason: "Project assignment failed; creating a new General project is safer than forcing an existing project.",
      };
    }
  }

  async selectFileManifestEntries(input: {
    query: string;
    route: MemoryRoute;
    recentUserMessages?: MemoryMessage[];
    projectMeta?: ProjectMetaRecord;
    manifest: RecallHeaderEntry[];
    limit?: number;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<string[]> {
    try {
      const parsed = await this.callStructuredJsonWithDebug<{ selected_ids?: unknown }>({
        systemPrompt: [
          "You select a small number of memory files from a compact manifest.",
          "Return JSON only with selected_ids.",
          "Select at most 5 ids and prefer recent items that are directly useful for the query.",
        ].join("\n"),
        userPrompt: JSON.stringify({
          query: input.query,
          route: input.route,
          recent_user_messages: (input.recentUserMessages ?? []).slice(-4).map((message) => truncateForPrompt(message.content, 220)),
          project: input.projectMeta
            ? {
                project_id: input.projectMeta.projectId,
                project_name: input.projectMeta.projectName,
                description: truncateForPrompt(input.projectMeta.description, 180),
                status: input.projectMeta.status,
              }
            : null,
          manifest: input.manifest.slice(0, 200).map((entry) => ({
            id: entry.relativePath,
            type: entry.type,
            scope: entry.scope,
            project_id: entry.projectId ?? null,
            updated_at: entry.updatedAt,
            description: truncateForPrompt(entry.description, 200),
          })),
          limit: Math.max(1, Math.min(5, input.limit ?? 5)),
        }, null, 2),
        requestLabel: "File memory selection",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_SELECTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as { selected_ids?: unknown },
      });
      const selected = normalizeStringArray(parsed.selected_ids, Math.max(1, Math.min(5, input.limit ?? 5)));
      return selected;
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory selection fallback: ${String(error)}`);
      return [];
    }
  }

  async extractFileMemoryCandidates(input: {
    timestamp: string;
    sessionKey?: string;
    messages: MemoryMessage[];
    batchContextMessages?: MemoryMessage[];
    knownProjects?: ProjectIdentityHint[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
    decisionTrace?: (debug: FileMemoryExtractionDebug) => void;
  }): Promise<MemoryCandidate[]> {
    const focusMessages = input.messages.filter((message) => message.role === "user");
    if (focusMessages.length === 0) return [];
    const batchContextMessages = input.batchContextMessages?.length
      ? input.batchContextMessages
      : input.messages;
    const focusText = focusMessages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    const explicitProjectName = extractProjectNameHint(focusText);
    const explicitProjectDescriptor = extractProjectDescriptorHint(focusText);
    const explicitProjectStage = extractProjectStageHint(focusText);
    const explicitTimeline = extractTimelineHints(focusText);
    const explicitGoal = extractSingleHint(focusText, /目标(?:是|为|:|：)?\s*([^。；;\n]+)/i);
    const explicitBlocker = extractSingleHint(focusText, /当前卡点(?:是|为)?([^。；;\n]+)/i);
    const genericProjectAnchor = hasGenericProjectAnchor(focusText);
    const uniqueBatchProjectName = extractUniqueBatchProjectName(batchContextMessages);
    const selectedKnownProject = selectKnownProjectHint(focusText, input.knownProjects ?? []);
    const contextProjectName = selectedKnownProject?.projectName ?? uniqueBatchProjectName;
    const projectFollowUpSignal = looksLikeProjectFollowUpText(focusText);
    const projectRiskSignal = looksLikeProjectRiskText(focusText);
    const projectScopeSignal = looksLikeProjectScopeText(focusText);
    const projectDefinitionSignal = Boolean(
      explicitProjectName
      || explicitProjectDescriptor
      || explicitProjectStage
      || explicitGoal
      || explicitBlocker
      || explicitTimeline.length > 0
      || projectRiskSignal
      || projectScopeSignal
      || looksLikeConcreteProjectMemoryText(focusText)
    );
    const feedbackInstructionSignal = looksLikeCollaborationRuleText(focusText);

    try {
      const parsed = await this.callStructuredJsonWithDebug<{ items?: unknown[] }>({
        systemPrompt: [
          "你需要利用自上次索引游标以来的近期会话上下文，从一个焦点对话轮次中提取长期记忆候选项。",
          "只返回 JSON，且必须包含 items 数组。",
          "允许的 item.type 值为 user、feedback、project。",
          "丢弃过于短暂或对未来会话没有价值的内容。",
          "可以使用批次上下文解释焦点轮次中的模糊指代，但只能输出由焦点用户轮次本身支持的记忆。",
          "known_projects 包含当前工作区项目的持久身份信息。",
          "批次上下文中的助手回复仅作为辅助上下文。绝不能仅根据助手措辞创建记忆候选项。",
          "user 项只保留稳定的个人身份/背景事实或持久关系。绝不能把项目状态、协作规则、回复偏好、语言选择、风格规则或文件边界放入 user 记忆。",
          "如果第一人称陈述实际是在说明助手应如何协作、写作、格式化、回复或操作文件，它属于 feedback，而不是 user。",
          "看起来全局有效的回复偏好和个人文件边界，在当前运行时中仍属于 feedback。例如：'默认使用中文输出'、'如果有结论先给结论再给细节'、'不要改动我的 .gitignore 文件'、'我更关心项目进度、风险和上线阻塞点'。",
          "如果焦点轮次告诉助手应如何协作、交付、汇报、格式化或组织输出，它属于 feedback，而不是 project。",
          "如果焦点轮次说明输出应如何交付，例如标题数量、正文顺序、封面文案、进展汇报顺序或回复结构，必须分类为 feedback，而不是 project。",
          "feedback 项必须始终提供 rule、why 和 how_to_apply。",
          "对于 feedback 项，why 表示用户为什么提出该反馈，通常是过去的事件、强烈偏好或明确不满。如果对话中没有原因，不要虚构。",
          "对于 feedback 项，how_to_apply 表示应在何时或何处应用该指导，例如进展更新、审阅或项目回复。若应用场景不明确，不要原样重复 rule。",
          "如果对话给出了规则，但没有足够证据填写 why 或 how_to_apply，对相应字段返回空字符串。",
          "Feedback 属于当前项目工作流；如果 project_id 不明确，可以省略，因为运行时已经知道当前项目。",
          "如果批次上下文包含当前项目身份，可以为 feedback 项附加 project_id；在当前项目模式下留空也可以接受。",
          "如果焦点用户轮次明确要求助手长期记住某事，例如'请记住'、'帮我记住'或'remember this'，将其视为应提取持久记忆的更强信号。",
          "该强信号仍必须基于原始用户文本本身。不要依赖任何隐藏的 remember 标记或外部规则，只根据可见对话内容判断。",
          "project 项应始终优先提供 name 和 description。project_id 可选，提供时只能表示当前项目身份。",
          "如果只知道项目的人类可读标题，将其放入 name，并将 project_id 留空。",
          "不要只把人类可读的项目标题放入 project_id。",
          "project 项应提供 stage、decisions、constraints、next_steps、blockers；提到日期时还应提供使用绝对日期的 timeline 条目。项目身份仍不明确时可以省略 project_id。",
          "项目定义轮次涉及项目名称、项目是什么、所处阶段、目标、阻塞、里程碑或时间线。单独的交付规则绝不是 project 项。",
          "即使没有记忆指令，也要把明确的项目定义陈述视为 project 记忆。例如：'这个项目先叫 Boreal'、'它是一个本地知识库整理工具'、'目前还在设计阶段'。",
          "自然的后续轮次即使没有重复项目名称，也仍然可以成为 project 记忆。",
          "如果批次上下文已包含当前项目身份，而焦点轮次出现'这个项目接下来最该补的是...'、'这个方向还差...'、'先把镜头顺序模板化'等表达，或提到阶段、优先级、阻塞、约束、目标受众或内容角度，应为当前项目输出 project 项。",
          "如果 known_projects 包含当前项目身份，且焦点轮次在未重复项目名称的情况下陈述当前范围、保留工具、风险、阻塞或项目后续事实，应将记忆关联到当前项目，而不是虚构新的顶层项目。",
          "当批次上下文已经唯一确定项目身份时，不要要求焦点轮次重复项目名称。",
          "明确的协作指令应视为 feedback。例如：'在这个项目里，每次给我交付时都先给3个标题，再给正文，再给封面文案。'",
          "当对话给出项目名称、描述项目是什么或说明当前阶段时，应输出 project 项，除非内容明显过于短暂。",
          "不要创建 overview、project 或 memory-item 之类占位项目名。",
          "'这个项目'之类通用指代，只有在批次上下文提供唯一项目身份时，才能成为 project 记忆。",
          "如果没有应保存的持久记忆，返回 {\"items\":[]}。",
        ].join("\n"),
        userPrompt: JSON.stringify({
          timestamp: input.timestamp,
          known_projects: (input.knownProjects ?? []).slice(0, 20).map((project) => ({
            identity_key: project.identityKey,
            project_id: project.projectId ?? "",
            project_name: project.projectName,
            description: truncateForPrompt(project.description, 180),
            scope: project.scope,
            updated_at: project.updatedAt,
          })),
          batch_context: batchContextMessages.map((message) => ({
            role: message.role,
            content: truncateForPrompt(message.content, 260),
          })),
          focus_user_turn: focusMessages.map((message) => ({
            role: message.role,
            content: truncateForPrompt(message.content, 320),
          })),
        }, null, 2),
        requestLabel: "File memory extraction",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as { items?: unknown[] },
      });
      if (!Array.isArray(parsed.items)) {
        input.decisionTrace?.({
          parsedItems: [],
          normalizedCandidates: [],
          discarded: [{
            reason: "invalid_schema",
            summary: "Model output did not contain an items array.",
          }],
          finalCandidates: [],
        });
        return [];
      }
      const discarded: FileMemoryExtractionDiscardedCandidate[] = [];
      const parsedItems = parsed.items.filter(isRecord);
      const items = parsedItems
        .map((item): MemoryCandidate | null => {
          const type = item.type === "feedback" || item.type === "project" ? item.type : item.type === "user" ? "user" : null;
          if (!type) {
            discarded.push({
              reason: "invalid_schema",
              summary: typeof item.type === "string" ? `Unsupported type: ${item.type}` : "Missing candidate type.",
            });
            return null;
          }
          const rawName = typeof item.name === "string" ? truncateForPrompt(item.name, 80) : "";
          const rawProjectName = typeof item.project_name === "string" ? truncateForPrompt(item.project_name, 80) : "";
          const rawProjectId = typeof item.project_id === "string" ? truncateForPrompt(item.project_id, 80) : "";
          const rawContent = typeof item.content === "string"
            ? truncateForPrompt(normalizeWhitespace(item.content), 280)
            : "";
          const feedbackRule = typeof item.rule === "string"
            ? truncateForPrompt(normalizeWhitespace(item.rule), 220)
            : "";
          const rawDescription = typeof item.description === "string"
            ? truncateForPrompt(item.description, 180)
            : "";
          const rawSummary = typeof item.summary === "string"
            ? truncateForPrompt(item.summary, 180)
            : "";
          const rawStage = typeof item.stage === "string"
            ? truncateForPrompt(item.stage, 220)
            : "";
          const rawGoal = typeof item.goal === "string"
            ? truncateForPrompt(normalizeWhitespace(item.goal), 180)
            : "";
          const rawDecisions = normalizeStringArray(item.decisions, 10);
          const rawConstraints = normalizeStringArray(item.constraints, 10);
          const rawNextSteps = normalizeStringArray(item.next_steps, 10);
          const rawBlockers = normalizeStringArray(item.blockers, 10);
          const timeline = normalizeStringArray(item.timeline, 10);
          const rawNotes = normalizeStringArray(item.notes, 10);
          const structuredProjectSummary = truncateForPrompt(
            rawDecisions[0]
            || rawConstraints[0]
            || rawNextSteps[0]
            || rawBlockers[0]
            || timeline[0]
            || rawNotes[0]
            || "",
            180,
          );
          if (type === "feedback" && !feedbackRule) {
            discarded.push({
              reason: "invalid_schema",
              candidateType: type,
              ...((rawName || typeof item.name === "string") ? { candidateName: rawName || String(item.name).trim() } : {}),
              summary: "Feedback candidate missing a non-empty rule.",
            });
            return null;
          }
          const candidateType = type;
          const shouldPinToKnownProject = Boolean(selectedKnownProject && !explicitProjectName);
          const projectNameFallback = candidateType === "project"
            ? truncateForPrompt(
              explicitProjectName
              || (shouldPinToKnownProject ? selectedKnownProject?.projectName ?? "" : "")
              || rawName
              || rawProjectName
              || (isLikelyHumanReadableProjectIdentifier(rawProjectId) ? rawProjectId : "")
              || extractProjectNameFromContent(rawContent)
              || contextProjectName,
              80,
            )
            : "";
          const description = rawDescription
            || (typeof item.profile === "string"
              ? truncateForPrompt(item.profile, 180)
              : rawContent
                ? sanitizeProjectDescriptionText(rawContent, projectNameFallback)
              : rawSummary
                ? rawSummary
                : feedbackRule
                  ? truncateForPrompt(feedbackRule, 180)
                  : rawGoal
                    ? rawGoal
                    : explicitProjectDescriptor
                      ? explicitProjectDescriptor
                    : explicitGoal
                        ? explicitGoal
                        : rawStage
                          ? truncateForPrompt(rawStage, 180)
                          : explicitProjectStage
                            ? truncateForPrompt(explicitProjectStage, 180)
                            : structuredProjectSummary);
          const normalizedProjectDescription = candidateType === "project"
            && structuredProjectSummary
            && (!description || description === explicitProjectDescriptor || description === explicitGoal)
            ? structuredProjectSummary
            : description;
          const name = candidateType === "user"
            ? "user-profile"
            : candidateType === "feedback"
              ? truncateForPrompt(rawName || deriveFeedbackCandidateName(feedbackRule), 80)
              : projectNameFallback;
          const preferences = candidateType === "user"
            ? []
            : normalizeStringArray(item.preferences, 10);
          const constraints = candidateType === "user"
            ? []
            : rawConstraints;
          const decisions = candidateType === "project" && projectScopeSignal
            ? uniqueStrings([...rawDecisions, normalizeWhitespace(stripExplicitRememberLead(focusText))], 10)
            : rawDecisions;
          const nextSteps = rawNextSteps;
          const blockers = candidateType === "project" && projectRiskSignal
            ? uniqueStrings([...rawBlockers, normalizeWhitespace(stripExplicitRememberLead(focusText))], 10)
            : rawBlockers;
          const notes = candidateType === "project" && !projectScopeSignal && !projectRiskSignal
            ? rawNotes
            : uniqueStrings(rawNotes, 10);
          const relationships = normalizeStringArray(item.relationships, 10);
          const hasUserPayload = Boolean(
            normalizedProjectDescription
            || rawContent
            || (typeof item.profile === "string" && normalizeWhitespace(item.profile))
            || (typeof item.summary === "string" && normalizeWhitespace(item.summary))
            || relationships.length > 0,
          );
          if (candidateType === "project" && (!name || !description)) {
            discarded.push({
              reason: "invalid_schema",
              candidateType,
              ...((name || rawName) ? { candidateName: name || rawName } : {}),
              summary: "Candidate missing a stable name or description.",
            });
            return null;
          }
          if (candidateType === "user" && (!name || !hasUserPayload)) {
            discarded.push({
              reason: "invalid_schema",
              candidateType,
              candidateName: "user-profile",
              summary: "User candidate did not contain any durable profile content.",
            });
            return null;
          }
          if (candidateType === "project" && isGenericProjectCandidateName(name)) {
            discarded.push({
              reason: "generic_project_name",
              candidateType,
              candidateName: name,
              summary: description,
            });
            return null;
          }
          return {
            type: candidateType,
            scope: candidateType === "user" ? "global" : "project",
            ...(() => {
              if (candidateType !== "project" && candidateType !== "feedback") return {};
              if (typeof item.project_id === "string" && isStableFormalProjectId(item.project_id)) {
                return { projectId: item.project_id.trim() };
              }
              if (selectedKnownProject?.projectId && isStableFormalProjectId(selectedKnownProject.projectId)) {
                return { projectId: selectedKnownProject.projectId };
              }
              return {};
            })(),
            name,
            description: normalizedProjectDescription,
            ...(input.sessionKey ? { sourceSessionKey: input.sessionKey } : {}),
            capturedAt: input.timestamp,
            ...(typeof item.profile === "string"
              ? { profile: truncateForPrompt(item.profile, 280) }
              : rawContent
                ? { profile: rawContent }
                : {}),
            ...(typeof item.summary === "string" ? { summary: truncateForPrompt(item.summary, 280) } : {}),
            ...(preferences.length > 0 ? { preferences } : {}),
            ...(constraints.length > 0 ? { constraints } : {}),
            ...(relationships.length > 0 ? { relationships } : {}),
            ...(candidateType === "feedback" && feedbackRule ? { rule: feedbackRule } : {}),
            ...(typeof item.why === "string" && sanitizeFeedbackSectionText(item.why)
              && candidateType === "feedback"
              ? { why: truncateForPrompt(sanitizeFeedbackSectionText(item.why), 280) }
              : {}),
            ...(typeof item.how_to_apply === "string" && sanitizeFeedbackSectionText(item.how_to_apply)
              && candidateType === "feedback"
              ? { howToApply: truncateForPrompt(sanitizeFeedbackSectionText(item.how_to_apply), 280) }
              : {}),
            ...(candidateType === "project" && rawStage ? { stage: rawStage } : {}),
            decisions,
            nextSteps,
            blockers,
            timeline,
            notes,
          };
        })
        .filter((item): item is MemoryCandidate => Boolean(item));
      const filtered = items.filter((item) => {
        const hasStructuredProjectEvidence = item.type === "project"
          && Boolean(
            item.stage
            || item.constraints?.length
            || item.decisions?.length
            || item.nextSteps?.length
            || item.blockers?.length
            || item.timeline?.length
            || item.notes?.length,
          );
        const text = [
          item.description,
          item.summary ?? "",
          item.rule ?? "",
          item.stage ?? "",
          ...(item.preferences ?? []),
          ...(item.notes ?? []),
          ...(item.nextSteps ?? []),
          ...(item.blockers ?? []),
          ...(item.timeline ?? []),
        ].join(" ");
        if (item.type === "user") {
          return true;
        }
        if (item.type === "project") {
          if (feedbackInstructionSignal && !projectDefinitionSignal) {
            discarded.push({
              reason: "violates_feedback_project_boundary",
              candidateType: item.type,
              candidateName: item.name,
              summary: item.description,
            });
            return false;
          }
          if (genericProjectAnchor && !projectDefinitionSignal && !contextProjectName) {
            discarded.push({
              reason: "generic_anchor_without_unique_project",
              candidateType: item.type,
              candidateName: item.name,
              summary: item.description,
            });
            return false;
          }
          if (
            genericProjectAnchor
            && !projectDefinitionSignal
            && contextProjectName
            && !hasStructuredProjectEvidence
            && !projectFollowUpSignal
            && !looksLikeConcreteProjectMemoryText(text)
            && !looksLikeProjectFollowUpText(text)
          ) {
            discarded.push({
              reason: "generic_anchor_without_project_definition",
              candidateType: item.type,
              candidateName: item.name,
              summary: item.description,
            });
            return false;
          }
        }
        if (item.type === "feedback" && projectDefinitionSignal && !feedbackInstructionSignal) {
          discarded.push({
            reason: "violates_feedback_project_boundary",
            candidateType: item.type,
            candidateName: item.name,
            summary: item.description,
          });
          return false;
        }
        return true;
      });
      const syntheticProjectFallback = filtered.length === 0
        && !feedbackInstructionSignal
        && contextProjectName
        && (
          projectFollowUpSignal
          || projectRiskSignal
          || projectScopeSignal
          || (genericProjectAnchor && looksLikeConcreteProjectMemoryText(focusText))
        )
        ? buildSyntheticProjectFollowUpCandidate({
            focusText,
            timestamp: input.timestamp,
            ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
            uniqueBatchProjectName: contextProjectName,
            explicitProjectName,
            explicitProjectDescriptor,
            explicitProjectStage,
            explicitTimeline,
            explicitGoal,
            explicitBlocker,
          })
        : null;
      const finalCandidates = syntheticProjectFallback ? [syntheticProjectFallback] : filtered;
      input.decisionTrace?.({
        parsedItems,
        normalizedCandidates: items,
        discarded,
        finalCandidates,
      });
      return finalCandidates;
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory extraction fallback: ${String(error)}`);
      input.decisionTrace?.({
        parsedItems: [],
        normalizedCandidates: [],
        discarded: [{
          reason: "extract_error",
          summary: error instanceof Error ? error.message : String(error),
        }],
        finalCandidates: [],
      });
      return [];
    }
  }
}
