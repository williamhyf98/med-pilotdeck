import { resolve } from "node:path";
import {
  getPilotProjectChatDir,
  resolveAgentCwd,
  sanitizeSessionIdForTranscript,
} from "../../pilot/index.js";
import { JsonlTranscriptWriter } from "../transcript/JsonlTranscriptWriter.js";

export type AgentProjectSessionStorageOptions = {
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
  now?: () => Date;
};

export type AgentProjectSessionStorage = {
  chatDir: string;
  transcriptPath: string;
  toolResultsDir: string;
  /**
   * Per-session directory for file-history backups (C4 / F5). Backups land
   * at `<fileHistoryDir>/<sha16(filePath)>@v<version>` and survive process
   * restarts. The `FileHistoryStore` lazily creates the dir on first
   * `trackEdit`.
   */
  fileHistoryDir: string;
  /**
   * Per-session directory for subagent sidechain transcripts (C3 §6.3).
   * Each forked subagent gets its own `<subagentId>.jsonl` here.
   */
  subagentsDir: string;
  subagentTranscriptPath(subagentId: string): string;
  transcript: JsonlTranscriptWriter;
};

/**
 * Sanitize a sessionId for safe use as a single filename component.
 *
 * 实现已上移到 `src/pilot/paths.ts` 的 `sanitizeSessionIdForTranscript`，
 * 与 Case State 目录的另一套清洗规则并排放在一起（两套规则不兼容且都不能改，
 * 那里有完整说明）。这里保留原名转发，是因为已有 8 处导入点用的是这个名字。
 */
export const sanitizeSessionIdForPath = sanitizeSessionIdForTranscript;

export function createAgentProjectSessionStorage(
  options: AgentProjectSessionStorageOptions,
): AgentProjectSessionStorage {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const safeId = sanitizeSessionIdForPath(options.sessionId);
  const transcriptPath = resolve(chatDir, `${safeId}.jsonl`);
  // Keep large tool-result bodies inside the workspace so the agent can read
  // them back with read_file when the inline preview is insufficient. The
  // project-local .pilotdeck directory is gitignored and already within the
  // workspace path boundary enforced by read_file.
  const agentCwd = resolveAgentCwd(options.projectRoot, options.pilotHome);
  const toolResultsDir = resolve(agentCwd, ".pilotdeck", "tool-results", safeId);
  const fileHistoryDir = resolve(chatDir, safeId, "file-history");
  const subagentsDir = resolve(chatDir, safeId, "subagents");
  const subagentTranscriptPath = (subagentId: string): string =>
    resolve(subagentsDir, `${sanitizeSessionIdForPath(subagentId)}.jsonl`);
  return {
    chatDir,
    transcriptPath,
    toolResultsDir,
    fileHistoryDir,
    subagentsDir,
    subagentTranscriptPath,
    transcript: new JsonlTranscriptWriter({
      path: transcriptPath,
      now: options.now,
      subagentTranscriptPath,
    }),
  };
}
