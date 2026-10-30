/**
 * 记忆域窄接口（Task 6）。
 *
 * 战创伤链路需要读全局画像和当前项目 Feedback，但**不能**拿到底层 repository：
 * 直接暴露 repository 会让 Trauma 侧有能力读写任意项目的任意记忆类型，
 * 与 §3.7 的隔离要求相悖。这里只开放「读这两类」这一件事。
 *
 * 作用域保证（必测项的结构性依据，不是运行期判断）：
 *   - `EdgeClawMemoryService` 是**按项目实例化**的（`workspaceDir` = 项目根，
 *     dbPath/memoryDir 都由它派生）。所以 facade 拿到哪个 service，
 *     就只可能读到哪个项目的记忆，其他项目的记忆在物理上不可达。
 *   - Case State 存在 `cases/<caseDirSlug>/` 下，由 `TraumaCaseStore` 管理，
 *     完全不经过记忆库。facade 只取 `## User Profile` 和 `## Feedback Memory`
 *     两段，`## Project Meta` / `## Project Memory` 一律丢弃——对战创伤而言
 *     project 段就是病例内容，召回它等于跨病例泄漏。
 *
 * 失败策略：召回失败只记 warning 并返回 null，绝不抛出。战创伤推演不能因为
 * 记忆不可用而中断（Task 6 硬性要求）。
 */

import { redact } from "./MemoryPrivacyPolicy.js";
import type { MemoryScopeIdentity } from "./MemoryScopeIdentity.js";

/** 单段召回内容的字符上限。超出部分截断并追加省略标记。 */
export const MEMORY_SECTION_CHAR_LIMIT = 2_000;

/** 两段合计的字符上限，防止记忆挤占知识块的 prompt 预算。 */
export const MEMORY_TOTAL_CHAR_LIMIT = 3_000;

const TRUNCATION_MARKER = "\n\n…（已截断）";

type LoggerLike = {
  warn?: (...args: unknown[]) => void;
};

/** facade 依赖的最小 service 能力，便于测试替身。 */
export type MemoryDomainServiceLike = {
  retrieveContext(
    query: string,
    options?: {
      workspaceHint?: string;
      retrievalMode?: "auto" | "explicit";
      signal?: AbortSignal;
    },
  ): Promise<{ systemContext?: string; context?: string }>;
  readPresentationMemory?(): {
    globalProfile?: string;
    projectFeedback?: string;
  };
  /**
   * 写入一轮原始会话供后续提取（Task 7）。
   *
   * 可选：只读场景（Task 6）的替身不必实现；缺省时 `capture()` 直接返回 false。
   */
  captureTurn?(
    rawMessages: readonly unknown[],
    input: { sessionKey: string; timestamp?: string; source?: string },
  ): { captured: boolean } | void;
};

/** 读取结果。两段都可能缺省——没有内容时字段不出现。 */
export type MemoryDomainReadResult = {
  /** 全局画像（`## 身份背景` / `## 专业领域` 两段的召回投影）。 */
  globalProfile?: string;
  /** 当前项目的 Feedback 记忆。 */
  projectFeedback?: string;
};

export type TraumaPreferenceMemory = MemoryDomainReadResult;

export type MemoryDomainFacadeOptions = {
  service: MemoryDomainServiceLike;
  identity: MemoryScopeIdentity;
  logger?: LoggerLike;
  /** 覆盖单段上限，仅测试使用。 */
  sectionCharLimit?: number;
  /** 覆盖总长上限，仅测试使用。 */
  totalCharLimit?: number;
};

export type MemoryDomainReadInput = {
  /** 本轮检索 query，通常是用户原始输入。 */
  query: string;
  signal?: AbortSignal;
};

/**
 * 写入输入（Task 7）。
 *
 * `text` 必须是**已经过策略过滤与脱敏**的内容——facade 不做内容判定，
 * 那是 `TraumaMemoryCapturePolicy` 的职责。这里只负责把它交给 service。
 */
export type MemoryDomainWriteInput = {
  sessionId: string;
  text: string;
  timestamp?: string;
  source?: string;
};

/**
 * 记忆域窄接口。只读，只有两段，不暴露 repository。
 */
export class MemoryDomainFacade {
  private readonly sectionLimit: number;
  private readonly totalLimit: number;

  constructor(private readonly options: MemoryDomainFacadeOptions) {
    this.sectionLimit = options.sectionCharLimit ?? MEMORY_SECTION_CHAR_LIMIT;
    this.totalLimit = options.totalCharLimit ?? MEMORY_TOTAL_CHAR_LIMIT;
  }

  /** 当前 facade 绑定的作用域身份（调用方用于审计，不用于定位）。 */
  get identity(): MemoryScopeIdentity {
    return this.options.identity;
  }

  /**
   * 读取全局画像与当前项目 Feedback。
   *
   * 任何失败（service 抛错、超时、解析异常）都只记 warning 并返回 null。
   */
  async read(input: MemoryDomainReadInput): Promise<MemoryDomainReadResult | null> {
    const query = input.query?.trim();
    if (!query) return null;
    if (input.signal?.aborted) return null;

    let systemContext: string;
    try {
      const result = await this.options.service.retrieveContext(query, {
        // workspaceHint 只是给召回排序的提示；真正的项目隔离来自 service 实例本身。
        workspaceHint: this.options.identity.projectPath,
        retrievalMode: "auto",
        signal: input.signal,
      });
      systemContext = (result.systemContext ?? result.context ?? "").trim();
    } catch (error) {
      this.options.logger?.warn?.(
        "[memory] 战创伤记忆召回失败，本轮跳过记忆注入：",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    if (!systemContext) return null;

    try {
      return this.project(systemContext);
    } catch (error) {
      this.options.logger?.warn?.(
        "[memory] 战创伤记忆解析失败，本轮跳过记忆注入：",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /** 确定性读取展示偏好，不经过语义路由。 */
  readPresentationMemory(): TraumaPreferenceMemory | null {
    const readPresentationMemory = this.options.service.readPresentationMemory?.bind(this.options.service);
    if (!readPresentationMemory) return null;

    try {
      return this.projectPresentationMemory(readPresentationMemory());
    } catch (error) {
      this.options.logger?.warn?.(
        "[memory] 战创伤展示偏好读取失败，本轮跳过记忆注入：",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * 写入一条已过滤、已脱敏的内容（Task 7）。
   *
   * 只写 `role: "user"` 单条消息：提取管线以 focus user turn 为判定中心，
   * 助手回答在战创伤侧一律不进候选池（见 `TraumaMemoryCapturePolicy` 顶注）。
   *
   * 失败只记 warning 并返回 false，绝不抛出——记忆写入不能中断推演。
   */
  capture(input: MemoryDomainWriteInput): boolean {
    const text = input.text?.trim();
    if (!text) return false;

    const captureTurn = this.options.service.captureTurn?.bind(this.options.service);
    if (!captureTurn) return false;

    try {
      const result = captureTurn([{ role: "user", content: text }], {
        sessionKey: input.sessionId,
        timestamp: input.timestamp ?? new Date().toISOString(),
        source: input.source ?? "pilotdeck-trauma",
      });
      // service 返回 void 的替身按「写入成功」处理。
      return result ? result.captured : true;
    } catch (error) {
      this.options.logger?.warn?.(
        "[memory] 战创伤记忆写入失败，本轮跳过：",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /**
   * 把召回出来的 systemContext 投影成两段。
   *
   * 只认 `## User Profile` 和 `## Feedback Memory`；其余段落（含 Project Meta /
   * Project Memory）直接丢弃，不做兜底合并——丢弃是这里的正确行为。
   */
  private project(systemContext: string): MemoryDomainReadResult | null {
    const sections = splitRecallSections(systemContext);
    return this.projectPresentationMemory({
      globalProfile: sections.get("User Profile"),
      projectFeedback: sections.get("Feedback Memory"),
    });
  }

  private projectPresentationMemory(input: {
    globalProfile?: string;
    projectFeedback?: string;
  }): MemoryDomainReadResult | null {
    const rawProfile = input.globalProfile;
    const rawFeedback = input.projectFeedback;

    let remaining = this.totalLimit;
    const result: MemoryDomainReadResult = {};

    // Feedback 优先于全局画像占用预算：它是当前项目的明确约束，
    // 比跨项目的身份背景更贴近本轮任务（与 prompt 里的优先级一致）。
    const feedback = this.sanitize(rawFeedback, remaining);
    if (feedback) {
      result.projectFeedback = feedback;
      remaining -= feedback.length;
    }

    const profile = this.sanitize(rawProfile, remaining);
    if (profile) {
      result.globalProfile = profile;
    }

    if (!result.projectFeedback && !result.globalProfile) return null;
    return result;
  }

  /** 脱敏 + 截断。空内容返回 undefined。 */
  private sanitize(value: string | undefined, budget: number): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (budget <= 0) return undefined;

    // 召回内容理论上写入时已脱敏，这里再过一次：存量数据可能是改造前写入的。
    const redacted = redact(trimmed).text.trim();
    if (!redacted) return undefined;

    const limit = Math.min(this.sectionLimit, budget);
    if (redacted.length <= limit) return redacted;
    return `${redacted.slice(0, limit)}${TRUNCATION_MARKER}`;
  }
}

/**
 * `buildMemoryRecallSystemContext` 产出的顶层段落标题，外加它的前言标题。
 *
 * **只有这几个**才算段落边界。全局画像的正文自身就带 `## 身份背景` /
 * `## 专业领域` 两个小标题，
 * 按任意 `## ` 切分会把画像正文误判成新段落，导致整段丢失。
 */
const RECALL_SECTION_TITLES = new Set([
  "ClawXMemory Recall",
  "User Profile",
  "Project Meta",
  "Project Memory",
  "Feedback Memory",
]);

/**
 * 按已知顶层段名切分 `buildMemoryRecallSystemContext` 的输出。
 * 未知的 `## ` 标题一律当作正文保留。
 */
function splitRecallSections(systemContext: string): Map<string, string> {
  const sections = new Map<string, string>();
  let currentTitle: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!currentTitle) {
      buffer = [];
      return;
    }
    const content = buffer.join("\n").trim();
    if (content) {
      const existing = sections.get(currentTitle);
      sections.set(currentTitle, existing ? `${existing}\n\n${content}` : content);
    }
    buffer = [];
  };

  for (const rawLine of systemContext.split(/\r?\n/u)) {
    const heading = /^##\s+(.+?)\s*$/u.exec(rawLine.trim());
    if (heading && RECALL_SECTION_TITLES.has(heading[1])) {
      flush();
      currentTitle = heading[1];
      continue;
    }
    if (!currentTitle) continue;
    buffer.push(rawLine);
  }
  flush();

  return sections;
}
