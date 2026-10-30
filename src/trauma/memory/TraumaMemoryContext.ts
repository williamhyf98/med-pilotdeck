/**
 * 战创伤记忆上下文（Task 6）。
 *
 * 这是记忆内容进入战创伤推演的**唯一载体**。刻意与 `CaseState` 分开：
 * 记忆是「这位医生的长期背景 + 本项目的协作约定」，Case State 是「这名伤员本轮的
 * 客观伤情」，两者可信度和用途都不同。塞进 `caseHistory` 会让模型把记忆内容
 * 当作已确认的伤情事实，是 Task 6 明确禁止的。
 *
 * 因此它作为 user payload 里一个独立命名字段下发（见 `reasoner.ts` /
 * `knowledgeQa.ts`），并在 system prompt 里声明其优先级低于当前轮输入、
 * Case State 和 RAG 证据。
 */

/** 记忆召回的两段内容。两段都可缺省。 */
export type TraumaMemoryContext = {
  /** 全局用户画像（跨项目的医生身份/专业/偏好）。 */
  globalProfile?: string;
  /** 当前项目的 Feedback 记忆（协作与输出约定）。 */
  projectFeedback?: string;
};

/**
 * 召回优先级。**唯一真相源**——`reasonerPrompt.ts` 与 `knowledgeQaPrompt.ts`
 * 都插值这个常量，避免两份提示词各写一份而逐渐漂移。
 */
export const TRAUMA_MEMORY_PRIORITY_RULE = [
  "记忆信息的采信优先级（由高到低）：",
  "当前轮明确输入 > 当前病例 Case State > 已验证的医学知识/RAG 证据 > 当前项目 Feedback > 全局用户画像。",
  "memoryContext 里的内容属于最后两档：它只能影响表达方式、关注重点和沟通偏好，",
  "不得作为伤情事实、生命体征、检查结果、救治条件或医学依据使用；",
  "与当前轮输入、Case State 或知识块冲突时，一律以后者为准，并按后者作答。",
].join("\n");

export const TRAUMA_CLINICAL_AUTHORITY_RULE =
  "临床信息权威顺序：当前轮病例事实 > 当前病例 Case State > 已验证的医学知识/RAG 证据。表达偏好不得改变这一顺序。";

/**
 * 记忆上下文的提供者。runner 与知识问答通过它取本轮记忆，
 * 不直接持有 `MemoryDomainFacade`（保持 trauma 侧对记忆实现无感）。
 *
 * 约定：失败返回 null，不抛出。
 */
export type TraumaMemoryContextProvider = (input: {
  /** 本轮检索 query，通常是用户原始自由文本。 */
  query: string;
  signal?: AbortSignal;
}) => Promise<TraumaMemoryContext | null>;

export type TraumaPresentationMemoryProvider = () =>
  | TraumaMemoryContext
  | null
  | Promise<TraumaMemoryContext | null>;

/** 两段都为空时视为无记忆。 */
export function isEmptyTraumaMemoryContext(
  context: TraumaMemoryContext | null | undefined,
): boolean {
  if (!context) return true;
  return !context.globalProfile?.trim() && !context.projectFeedback?.trim();
}

/**
 * 渲染成下发给模型的字符串。无内容时返回 null，调用方据此把字段置为 null，
 * 与 `attachmentInterpretation` 的「无附件为 null」约定保持一致。
 */
export function renderTraumaMemoryContext(
  context: TraumaMemoryContext | null | undefined,
): string | null {
  if (isEmptyTraumaMemoryContext(context)) return null;

  const blocks: string[] = [];
  // Feedback 在前：它是当前项目的明确约定，优先级高于全局画像。
  const feedback = context!.projectFeedback?.trim();
  if (feedback) blocks.push(`## 当前项目 Feedback\n${feedback}`);

  const profile = context!.globalProfile?.trim();
  if (profile) blocks.push(`## 全局用户画像\n${profile}`);

  return blocks.join("\n\n");
}

/**
 * 安全地取一次记忆：provider 缺省或抛错都返回 null。
 *
 * provider 的契约已经要求不抛出，这里再兜一层——记忆是可选增强，
 * 任何异常都不该让战创伤推演失败。
 */
export async function resolveTraumaMemoryContext(
  provider: TraumaMemoryContextProvider | undefined,
  input: { query: string; signal?: AbortSignal },
  logger?: { warn?: (...args: unknown[]) => void },
): Promise<string | null> {
  if (!provider) return null;
  const query = input.query?.trim();
  if (!query) return null;

  try {
    const context = await provider({ query, signal: input.signal });
    return renderTraumaMemoryContext(context);
  } catch (error) {
    logger?.warn?.(
      "[trauma] 记忆上下文获取失败，本轮不注入记忆：",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/** 确定性读取长期展示偏好；不接受 query，因此不会退回语义路由。 */
export async function resolveTraumaPresentationMemory(
  provider: TraumaPresentationMemoryProvider | undefined,
  logger?: { warn?: (...args: unknown[]) => void },
): Promise<TraumaMemoryContext | null> {
  if (!provider) return null;

  try {
    const context = await provider();
    return isEmptyTraumaMemoryContext(context) ? null : context;
  } catch (error) {
    logger?.warn?.(
      "[trauma] 展示偏好记忆获取失败，本轮仅使用当前轮偏好：",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
