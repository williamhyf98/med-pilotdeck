/**
 * 记忆作用域的唯一身份解析器。
 *
 * 存在的理由是改造前有三套各自推导 projectId 的代码，和两套互不兼容的 sessionId
 * 清洗算法（见 `src/pilot/paths.ts` 里两个 sanitize 函数上方的说明）。三套推导里
 * 有两套是 `createLocalGateway.ts` 里就地写的 `split("/").at(-1)`——对已注册的
 * workspace 路径恰好能得出正确答案，对未注册的绝对路径会退化成「取最后一段目录名」，
 * 与 `resolveWorkspaceId` 的结果不一致。
 *
 * 契约：
 *   - 主键是 `projectId + sessionId`，display 名称永远不参与定位。
 *   - `transcriptSlug` 和 `caseDirSlug` 同时产出。需要「定位某个 session 的全部数据」
 *     的调用方（典型是删除）必须两个都消费，只用一个会留下孤儿数据。
 *   - 原始 `sessionId` 始终保留，API 返回值必须带上它，不能只返回 slug。
 *
 * JS 侧有一份等价实现 `ui/server/utils/memoryIdentity.js`（UI server 不能依赖 TS
 * 编译产物，这是既有约束）。两份实现由 `tests/fixtures/memory-identity.golden.json`
 * 这一份共享 fixture 守住——那是「手工同步两份实现」的唯一有效防线。
 */
import {
  PROJECT_TYPE_KEYS,
  projectTypeKeyFromProjectId,
  resolveWorkspaceId,
  sanitizeSessionIdForCaseDir,
  sanitizeSessionIdForTranscript,
  type ProjectMetaType,
  type ProjectTypeKey,
} from "../../pilot/index.js";

export type MemoryScopeIdentity = {
  /** 稳定的 typed storage id，唯一主键 */
  projectId: string;
  /** 元类型：`general_medicine` | `war_trauma` */
  projectType: ProjectMetaType;
  /**
   * 存储用的目录 / id 前缀 key：`general_med` | `trauma_med`。
   *
   * 和 `projectType` 是同一件事的两种写法，两个都给出来是因为调用点两种都在用
   * （`createLocalGateway.ts` 比的是 `"trauma_med"`，UI 侧用的是元类型名），
   * 只给一个必然导致调用点就地转换，又变回「就地推导」。
   */
  projectTypeKey: ProjectTypeKey;
  /** 可变的展示 / 工作路径，**不作为主键** */
  projectPath?: string;
  /** 原始 session id，API 中必须原样保留 */
  sessionId?: string;
  /** transcript 文件名组件（`<transcriptSlug>.jsonl`） */
  transcriptSlug?: string;
  /** Case State 目录名组件（`cases/<caseDirSlug>/`） */
  caseDirSlug?: string;
  /** 仅供 UI 展示，禁止用于定位 */
  displayName?: string;
};

export type ResolveMemoryScopeIdentityInput = {
  /** 网关/UI 传入的 project key：可以是绝对路径，也可以是 bare storage id */
  projectKey: string | null | undefined;
  pilotHome: string;
  sessionId?: string | null;
  displayName?: string | null;
};

/**
 * 解析记忆作用域身份。
 *
 * projectId 走 `resolveWorkspaceId`——它是既有的权威推导（能读 `.cwd` 标记、
 * 能处理 typed workspace 路径和 bare id），不要在调用点另行推导。
 *
 * 未知 / legacy 项目按历史行为归为 general_medicine，与
 * `projectMetaTypeFromProjectPath` 的兜底一致。
 */
export function resolveMemoryScopeIdentity(
  input: ResolveMemoryScopeIdentityInput,
): MemoryScopeIdentity {
  const projectId = resolveWorkspaceId(input.projectKey ?? null, input.pilotHome);
  const projectTypeKey = projectTypeKeyFromProjectId(projectId)
    ?? PROJECT_TYPE_KEYS.general_medicine;
  const projectType: ProjectMetaType = projectTypeKey === PROJECT_TYPE_KEYS.war_trauma
    ? "war_trauma"
    : "general_medicine";

  const identity: MemoryScopeIdentity = {
    projectId,
    projectType,
    projectTypeKey,
  };

  // projectKey 是路径形态时才作为 projectPath 记录；bare id 不是路径。
  if (typeof input.projectKey === "string" && input.projectKey.includes("/")) {
    identity.projectPath = input.projectKey;
  }
  if (typeof input.displayName === "string" && input.displayName.trim()) {
    identity.displayName = input.displayName;
  }

  // 空字符串 sessionId 是无意义输入，按「没有 session」处理；
  // 但一旦有 session，两个 slug 就必须成对出现，不允许只产出一个。
  if (typeof input.sessionId === "string" && input.sessionId.length > 0) {
    identity.sessionId = input.sessionId;
    identity.transcriptSlug = sanitizeSessionIdForTranscript(input.sessionId);
    identity.caseDirSlug = sanitizeSessionIdForCaseDir(input.sessionId);
  }

  return identity;
}

/** 该作用域是否为战创伤项目（Case State 只存在于这类项目下）。 */
export function isWarTraumaScope(identity: MemoryScopeIdentity): boolean {
  return identity.projectTypeKey === PROJECT_TYPE_KEYS.war_trauma;
}
