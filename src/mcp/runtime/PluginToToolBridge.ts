/**
 * `PluginToToolBridge` — converts the runtime view of MCP tools (advertised
 * by an `McpRuntime`) into PilotDeck `ToolDefinition`s suitable for
 * registration in `ToolRegistry`. Implements M10-M12 of §6.1:
 *
 *   - M10  wire name `mcp__<serverId>__<toolName>` (already produced by
 *          `McpClient.listTools`).
 *   - M11  description ≤ 2048 chars (already truncated).
 *   - M12  annotations.readOnlyHint / destructiveHint / openWorldHint
 *          reflected onto the PilotDeck tool flags so the permission
 *          engine can decide whether to ask.
 *
 * Result transformation (M14): MCP ContentBlock types `text` and `image`
 * are mapped to their PilotDeck equivalents so that images (e.g. Playwright
 * screenshots) render inline in the chat UI. Remaining block types
 * (`audio`, `resource`, `resource_link`) fall through as a single `json`
 * block until the downstream pipeline supports them.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";

import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type {
  PilotDeckCapability,
  PilotDeckToolArtifact,
} from "../../security/policy/types.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolInputSchema,
  PilotDeckToolResultContent,
  PilotDeckToolRuntimeContext,
} from "../../tool/index.js";
import type { PermissionResult } from "../../permission/index.js";
import type { McpClient } from "../client/McpClient.js";
import type { McpRuntime } from "./McpRuntime.js";
import type {
  PilotDeckMcpArtifactPolicy,
  PilotDeckMcpToolAnnotations,
  PilotDeckMcpToolCapabilities,
  PilotDeckMcpToolSpec,
} from "../protocol/types.js";
import { getMcpToolCapabilities } from "./mcpCapabilities.js";

export type CreateToolDefinitionsOptions = {
  /** Per-call timeout override (default falls through to McpClient default). */
  callTimeoutMs?: number;
};

export async function createMcpToolDefinitionsFromRuntime(
  runtime: McpRuntime,
  options: CreateToolDefinitionsOptions = {},
): Promise<PilotDeckToolDefinition[]> {
  const tools = await runtime.listAllTools();
  return tools.map((spec) => buildToolDefinition(spec, runtime, options));
}

function buildToolDefinition(
  spec: PilotDeckMcpToolSpec,
  runtime: McpRuntime,
  options: CreateToolDefinitionsOptions,
): PilotDeckToolDefinition {
  const annotations: PilotDeckMcpToolAnnotations = spec.annotations ?? {};
  const capabilities = spec.capabilities
    ?? getMcpToolCapabilities(spec.serverId, spec.toolName);
  const isReadOnly = capabilities?.readOnly ?? annotations.readOnlyHint === true;
  const isDestructive = annotations.destructiveHint === true;
  const isOpenWorld = annotations.openWorldHint !== false;

  const inputSchema = normalizeSchema(spec.inputSchema);
  const medicalParser = spec.serverId === "med-tools" && spec.toolName === "med_parse_medical";

  return {
    name: spec.wireName,
    description: medicalParser
      ? "解析医疗附件。纯解读用 continuation_mode=terminal：报告直接展示并保存为最终答案。结合病史分析或生成文件等复合任务用 material：报告作为内部材料，主 Agent 继续完成交付，影像判读保留原文。多附件优先一次批量解析。"
      : spec.description,
    kind: "mcp",
    inputSchema,
    maxResultBytes: 200_000,
    isReadOnly: () => isReadOnly,
    isConcurrencySafe: () => isReadOnly && (capabilities?.taskWriteRoots.length ?? 0) === 0,
    isDestructive: () => isDestructive,
    isOpenWorld: () => isOpenWorld,
    ...(capabilities ? {
      capabilityPolicy: {
        declared: declaredCapabilities(capabilities),
        required: () => requiredCapabilities(capabilities),
      },
    } : {}),
    checkPermissions: async (_input, context): Promise<PermissionResult> => {
      if (!capabilities) {
        return {
          type: "deny",
          reason: {
            type: "safety",
            message: `MCP tool ${spec.serverId}/${spec.toolName} has no registered capability profile.`,
          },
          message: `MCP tool ${spec.serverId}/${spec.toolName} has no registered capability profile.`,
        };
      }
      return { type: "passthrough" };
    },
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput> => {
      if (!capabilities) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          `MCP tool ${spec.serverId}/${spec.toolName} has no registered capability profile.`,
        );
      }
      const client: McpClient | undefined = runtime.getClient(spec.serverId);
      if (!client) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          `MCP server ${spec.serverId} is not registered`,
        );
      }
      const medicalActivity = medicalActivityDefinition(spec.serverId, spec.toolName);
      const activityId = `medical:${context.currentToolCallId || spec.wireName}`;
      const emitMedicalActivity = (
        update: { title: string; detail?: string; state: "running" | "completed" | "failed"; severity?: "warning" | "error" },
      ): void => {
        if (!medicalActivity || !context.progress) return;
        context.progress({
          type: "tool_progress",
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.currentToolCallId ?? "",
          toolName: spec.wireName,
          message: update.title,
          metadata: {
            channel: "medical_activity",
            activityId,
            phase: "medical",
            ...update,
          },
          createdAt: (context.now?.() ?? new Date()).toISOString(),
        });
      };
      try {
        const normalizedInput = normalizeMcpToolInputPaths(
          spec.serverId,
          spec.toolName,
          input,
          capabilities,
          context,
        );
        const streamSpec = directStreamSpec(spec.serverId, spec.toolName);
        const medicalMaterial = (medicalParser || (spec.serverId === "med-tools" && spec.toolName === "med_deepchest_job"))
          && readContinuationMode(normalizedInput) === "material";
        const directStream = streamSpec !== undefined;
        const directFinalField = streamSpec?.field;
        let streamedText = "";
        let reportStageEmitted = false;
        if (medicalActivity) {
          emitMedicalActivity({
            title: medicalActivity.startTitle,
            detail: medicalActivity.startDetail,
            state: "running",
          });
        }
        const emitDelta = (chunk: string): void => {
          if (!chunk || !context.progress || medicalMaterial) return;
          streamedText += chunk;
          context.progress({
            type: "tool_progress",
            sessionId: context.sessionId,
            turnId: context.turnId,
            toolCallId: context.currentToolCallId ?? "",
            toolName: spec.wireName,
            message: `plugin stream: ${chunk.length} chars`,
            metadata: {
              channel: "assistant_text_delta",
              text: chunk,
              modelOwner: "plugin-vlm",
            },
            createdAt: new Date().toISOString(),
          });
        };
        const { content: rawContent, isError } = await client.callTool(spec.toolName, normalizedInput, {
          signal: context.abortSignal,
          taskRoot: context.taskRoot,
          timeoutMs: options.callTimeoutMs,
          ...((directStream || medicalActivity) && context.progress
            ? {
                onProgress: (progress: { progress: number; total?: number; message?: string }) => {
                  if (typeof progress.message !== "string") return;
                  const stage = medicalProgressStage(spec.toolName, progress.message);
                  if (stage) {
                    emitMedicalActivity({ ...stage, state: "running" });
                    return;
                  }
                  if (directStream) {
                    if (spec.toolName === "med_parse_medical" && !reportStageEmitted) {
                      reportStageEmitted = true;
                      emitMedicalActivity({
                        title: "正在生成医学报告",
                        detail: "医学附件已完成本地解析",
                        state: "running",
                      });
                    }
                    emitDelta(progress.message);
                  }
                },
              }
            : {}),
        });
        // Adapt presentation metadata only. The plugin's G9 prompt/report is untouched.
        const content = medicalMaterial && !isError && Array.isArray(rawContent) ? rawContent.map((block: McpContentBlock) => {
          if (block.type !== "text" || typeof block.text !== "string") return block;
          try {
            const payload = JSON.parse(block.text);
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) return block;
            return { ...block, text: JSON.stringify({ ...payload, continuation_mode: "material", agent_continue: true,
              presentation: MEDICAL_MATERIAL_PRESENTATION }) };
          } catch { return block; }
        }) : rawContent;
        if (isError === true) {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            extractMcpErrorText(content, spec.serverId, spec.toolName),
            { content },
          );
        }
        const jsonPayload = extractJsonTextPayload(content);
        const parsedPayload = directStream ? jsonPayload : undefined;
        const finalText = parsedPayload?.ok === true
          && directFinalField
          && typeof parsedPayload[directFinalField] === "string"
          ? (parsedPayload[directFinalField] as string)
          : "";
        // Reconcile: if streaming under-delivered (e.g. sanitized final differs),
        // emit the missing suffix so the bubble matches the persisted answer.
        if (finalText && context.progress) {
          if (streamedText.length === 0) {
            emitDelta(finalText);
          } else if (finalText.startsWith(streamedText)) {
            emitDelta(finalText.slice(streamedText.length));
          }
        }
        if (medicalActivity) {
          emitMedicalActivity(medicalCompletion(spec.toolName, extractJsonTextPayload(content)));
        }
        const effectiveEndTurn = shouldEndTurnAfterDirectStream(
          spec.toolName,
          normalizedInput,
          parsedPayload?.continuation_mode,
        );
        const extractedArtifacts = await extractMcpArtifacts(
          spec.serverId,
          spec.toolName,
          jsonPayload,
          capabilities,
          context,
        );
        return {
          content: [
            ...marshalMcpContent(
              content,
              client.spec.transport === "stdio" ? client.spec.cwd : undefined,
              context.taskRoot,
            ),
            ...extractedArtifacts.content,
          ],
          ...(extractedArtifacts.artifacts.length > 0
            ? { artifacts: extractedArtifacts.artifacts }
            : {}),
          data: parsedPayload ?? content,
          metadata: {
            mcp: {
              serverId: spec.serverId,
              toolName: spec.toolName,
              wireName: spec.wireName,
              ...(extractedArtifacts.managedDerivedArtifacts.length > 0
                ? { managedDerivedArtifacts: extractedArtifacts.managedDerivedArtifacts }
                : {}),
            },
            ...(finalText
              ? {
                  generationOwner: "plugin-vlm",
                  ...(effectiveEndTurn ? { directFinalAssistantText: finalText } : {}),
                }
              : {}),
          },
        };
      } catch (err) {
        if (medicalActivity) {
          emitMedicalActivity({
            title: medicalActivity.failedTitle,
            detail: "流程未完成，请查看最终错误提示",
            state: "failed",
            severity: "error",
          });
        }
        if (err instanceof PilotDeckToolRuntimeError) throw err;
        const e = err as { code?: string; message?: string };
        if (e.code === "mcp_call_timeout") {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            e.message ?? `MCP call timed out (${spec.serverId}/${spec.toolName})`,
            { errorCode: "mcp_call_timeout" },
          );
        }
        if (e.code === "mcp_session_expired") {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            e.message ?? `MCP session expired (${spec.serverId}/${spec.toolName})`,
            { errorCode: "mcp_session_expired" },
          );
        }
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          e.message ?? `MCP call failed (${spec.serverId}/${spec.toolName})`,
          { errorCode: e.code ?? "mcp_call_failed" },
        );
      }
    },
  };
}

const PROJECT_PATH_MEDICAL_TOOLS = new Set([
  "med_deepchest_submit",
  "med_dicom_route",
  "med_image_route",
  "med_parse_medical",
]);

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function existingProjectPath(projectRoot: string, candidate: string): string | undefined {
  try {
    if (!existsSync(candidate)) return undefined;
    const resolved = realpathSync(candidate);
    return isPathInside(projectRoot, resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function findUniqueInboxPath(projectRoot: string, requestedPath: string): string | undefined {
  const inboxRoot = existingProjectPath(projectRoot, join(projectRoot, "inbox"));
  if (!inboxRoot) return undefined;

  const requestedName = basename(requestedPath);
  if (!requestedName || requestedName === "." || requestedName === "..") return undefined;

  const exactMatches: string[] = [];
  const prefixedMatches: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: inboxRoot, depth: 0 }];
  let visited = 0;

  while (pending.length > 0 && visited < 4096) {
    const current = pending.shift();
    if (!current) break;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > 4096) break;
      const entryPath = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 3) pending.push({ path: entryPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === requestedName) exactMatches.push(entryPath);
      else if (entry.name.endsWith(`-${requestedName}`)) prefixedMatches.push(entryPath);
    }
  }

  const matches = exactMatches.length > 0 ? exactMatches : prefixedMatches;
  if (matches.length !== 1) return undefined;
  return existingProjectPath(projectRoot, matches[0]);
}

const MCP_READ_PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "file_path",
  "file_paths",
  "image_path",
  "image_paths",
  "input_path",
  "input_paths",
  "input_file",
  "input_files",
  "source_path",
  "source_paths",
  "pdf_path",
  "pdf_paths",
  "directory",
  "directories",
  "dir",
  "dirs",
  "input_dir",
  "input_dirs",
  "input_directory",
  "input_directories",
  "document",
  "documents",
  "pdf",
  "pdfs",
]);

const MCP_WRITE_PATH_KEYS = new Set([
  "output_path",
  "output_paths",
  "output_file",
  "output_files",
  "output_dir",
  "output_directory",
  "render_dir",
  "out",
  "out_dir",
]);

function normalizeMcpToolInputPaths(
  serverId: string,
  toolName: string,
  input: unknown,
  capabilities: PilotDeckMcpToolCapabilities,
  context: PilotDeckToolRuntimeContext,
): unknown {
  // Stand-alone bridge callers historically supplied host paths and do not
  // carry an Agent task root. Agent calls always carry taskRoot and take the
  // strict path branch below.
  if (!context.taskRoot) {
    return normalizeMedicalToolInputPath(serverId, toolName, input, context.cwd);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  return normalizeMcpInputValue(input, undefined, capabilities, context);
}

function normalizeMcpInputValue(
  value: unknown,
  key: string | undefined,
  capabilities: PilotDeckMcpToolCapabilities,
  context: PilotDeckToolRuntimeContext,
): unknown {
  const access = key && MCP_WRITE_PATH_KEYS.has(key) ? "write"
    : key && MCP_READ_PATH_KEYS.has(key) ? "read"
      : undefined;

  if (access) {
    return normalizeMcpPathValue(value, access, capabilities, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeMcpInputValue(item, undefined, capabilities, context));
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      normalizeMcpInputValue(entryValue, entryKey, capabilities, context),
    ]),
  );
}

function normalizeMcpPathValue(
  value: unknown,
  access: "read" | "write",
  capabilities: PilotDeckMcpToolCapabilities,
  context: PilotDeckToolRuntimeContext,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeMcpPathValue(item, access, capabilities, context));
  }
  if (value && typeof value === "object") {
    return normalizeMcpInputValue(value, undefined, capabilities, context);
  }
  if (typeof value !== "string") {
    throw invalidMcpInputPath(access, "path fields must contain strings.");
  }
  if (!value.trim()) return value;

  const roots = access === "read" ? capabilities.taskReadRoots : capabilities.taskWriteRoots;
  if (roots.length === 0) {
    throw invalidMcpInputPath(
      access,
      `MCP tool does not declare a task ${access === "read" ? "input" : "output"} capability.`,
    );
  }

  return resolveMcpTaskPath(value, roots, access, context);
}

function resolveMcpTaskPath(
  requestedPath: string,
  allowedRoots: readonly ("inbox" | "scratch" | "exports")[],
  access: "read" | "write",
  context: PilotDeckToolRuntimeContext,
): string {
  const taskRoot = realpathOrThrow(context.taskRoot!, "current task");
  const cwd = safeRealpath(context.cwd);
  if (!cwd || !isPathInside(taskRoot, cwd) || hasSymlinkComponent(cwd, taskRoot)) {
    throw invalidMcpInputPath(access, "current working directory is outside the task.");
  }

  const absolute = isAbsolute(requestedPath);
  if (!absolute && (requestedPath.includes("\\") || requestedPath.split("/").includes(".."))) {
    throw invalidMcpInputPath(access, "path traversal is not allowed.");
  }

  const candidates = absolute
    ? [resolvePath(requestedPath)]
    : [
        resolvePath(cwd, requestedPath),
        resolvePath(taskRoot, requestedPath),
        resolvePath(taskRoot, "inbox", requestedPath),
      ];
  let resolved: string | undefined;
  for (const candidate of candidates) {
    const real = safeRealpath(candidate);
    if (!real || !isPathInside(taskRoot, real) || hasSymlinkComponent(real, taskRoot)) continue;
    const relativePath = relative(taskRoot, real).replace(/\\/g, "/");
    const root = relativePath.split("/")[0];
    if (!root || !allowedRoots.includes(root as "inbox" | "scratch" | "exports")) continue;
    if (access === "read" && !isRegularFileOrDirectory(real)) continue;
    resolved = real;
    break;
  }
  if (!resolved && !absolute && !requestedPath.includes("/")) {
    resolved = findUniqueAllowedTaskPath(taskRoot, requestedPath, allowedRoots);
  }
  if (!resolved) {
    throw invalidMcpInputPath(access, "path is outside the current task or does not exist.");
  }
  return resolved;
}

function findUniqueAllowedTaskPath(
  taskRoot: string,
  requestedName: string,
  allowedRoots: readonly ("inbox" | "scratch" | "exports")[],
): string | undefined {
  const matches: string[] = [];
  for (const root of allowedRoots) {
    const rootPath = join(taskRoot, root);
    if (!existsSync(rootPath)) continue;
    const pending: string[] = [rootPath];
    let visited = 0;
    while (pending.length > 0 && visited < 4096) {
      const current = pending.shift()!;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > 4096) break;
        const entryPath = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isFile() && entry.name === requestedName) {
          matches.push(entryPath);
        }
      }
    }
  }
  if (matches.length !== 1) return undefined;
  return safeRealpath(matches[0]);
}

function safeRealpath(value: string): string | undefined {
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function realpathOrThrow(value: string, label: string): string {
  const resolved = safeRealpath(value);
  if (!resolved) throw invalidMcpInputPath("read", `${label} is unavailable.`);
  return resolved;
}

function isRegularFileOrDirectory(value: string): boolean {
  try {
    const info = statSync(value);
    return info.isFile() || info.isDirectory();
  } catch {
    return false;
  }
}

function hasSymlinkComponent(target: string, root: string): boolean {
  const relativePath = relative(root, target);
  if (relativePath === "") return false;
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return true;
  let current = root;
  for (const part of relativePath.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function invalidMcpInputPath(
  access: "read" | "write",
  detail: string,
): PilotDeckToolRuntimeError {
  return new PilotDeckToolRuntimeError(
    "invalid_tool_input",
    `Invalid MCP ${access} path: ${detail}`,
  );
}

function normalizeMedicalToolInputPath(
  serverId: string,
  toolName: string,
  input: unknown,
  cwd: string,
): unknown {
  if (
    serverId !== "med-tools"
    || !PROJECT_PATH_MEDICAL_TOOLS.has(toolName)
    || !input
    || typeof input !== "object"
    || Array.isArray(input)
  ) {
    return input;
  }

  const record = input as Record<string, unknown>;
  const requestedPath = typeof record.path === "string" ? record.path.trim() : "";
  if (!requestedPath || isAbsolute(requestedPath) || !cwd) return input;

  let projectRoot: string;
  try {
    projectRoot = realpathSync(cwd);
  } catch {
    return input;
  }

  const directCandidates = [
    resolvePath(projectRoot, requestedPath),
    resolvePath(projectRoot, "inbox", requestedPath),
  ];
  let resolvedPath: string | undefined;
  for (const candidate of directCandidates) {
    if (!isPathInside(projectRoot, candidate)) continue;
    resolvedPath = existingProjectPath(projectRoot, candidate);
    if (resolvedPath) break;
  }
  resolvedPath ??= findUniqueInboxPath(projectRoot, requestedPath);

  return resolvedPath ? { ...record, path: resolvedPath } : input;
}

type MedicalActivityDefinition = {
  startTitle: string;
  startDetail: string;
  failedTitle: string;
};

const MEDICAL_ACTIVITY_DEFINITIONS: Record<string, MedicalActivityDefinition> = {
  med_dicom_route: {
    startTitle: "正在读取 DICOM 元数据",
    startDetail: "本地识别模态、部位和序列完整性",
    failedTitle: "DICOM 路由失败",
  },
  med_image_route: {
    startTitle: "正在检查医学影像",
    startDetail: "本地识别格式和三维影像信息",
    failedTitle: "影像路由失败",
  },
  med_parse_medical: {
    startTitle: "正在解析医学附件",
    startDetail: "读取元数据并准备影像关键帧",
    failedTitle: "医学附件解析失败",
  },
  med_radar_status: {
    startTitle: "正在检查 RADAR 服务",
    startDetail: "确认模型和 CUDA 运行状态",
    failedTitle: "RADAR 服务检查失败",
  },
  med_deepchest_status: {
    startTitle: "正在检查 DeepChest 服务", startDetail: "检查运行环境和任务队列", failedTitle: "DeepChest 服务检查失败",
  },
  med_deepchest_submit: {
    startTitle: "正在提交胸部 CT", startDetail: "为本次影像创建独立分析任务", failedTitle: "DeepChest 提交失败",
  },
  med_deepchest_job: {
    startTitle: "正在查询胸部 CT 分析进度", startDetail: "等待分割、特征提取和中文分析", failedTitle: "DeepChest 查询失败",
  },
  med_radar_analyze_ct: {
    startTitle: "正在准备 RADAR CT 输入",
    startDetail: "检查三维影像并准备推理",
    failedTitle: "RADAR 分析失败",
  },
};

const MEDICAL_PROGRESS_PREFIX = "__PILOTDECK_MEDICAL_STAGE__:";

function medicalActivityDefinition(serverId: string, toolName: string): MedicalActivityDefinition | undefined {
  if (serverId !== "med-tools") return undefined;
  return MEDICAL_ACTIVITY_DEFINITIONS[toolName];
}

function medicalProgressStage(
  toolName: string,
  message: string,
): { title: string; detail?: string } | undefined {
  if (!message.startsWith(MEDICAL_PROGRESS_PREFIX)) return undefined;
  const stage = message.slice(MEDICAL_PROGRESS_PREFIX.length).trim();
  const stages: Record<string, Record<string, { title: string; detail?: string }>> = {
    med_radar_analyze_ct: {
      inference: { title: "正在执行 RADAR 推理", detail: "远程模型正在分析三维 CT" },
      artifacts: { title: "正在整理 RADAR 结果", detail: "保存评分和可复核产物" },
    },
  };
  return stages[toolName]?.[stage];
}

function safeActivityValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !/^[\p{L}\p{N}_.:-]+$/u.test(trimmed)) return fallback;
  return trimmed;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function medicalCompletion(
  toolName: string,
  payload: Record<string, unknown> | undefined,
): { title: string; detail?: string; state: "running" | "completed" | "failed"; severity?: "warning" | "error" } {
  const data = payload ?? {};
  if (toolName.startsWith("med_deepchest_")) {
    const failed = data.status === "failed" || data.status === "error"
      || (toolName === "med_deepchest_status" && data.ready !== true);
    const pending = ["waiting", "running", "uploading"].includes(String(data.status));
    const phases: Record<string, string> = { prepare: "校验本次影像", segment: "生成器官分割", ctclip: "提取影像证据", answer: "生成中文分析" };
    return {
      title: failed ? "DeepChest 任务未完成" : pending ? "胸部 CT 分析进行中" : toolName === "med_deepchest_status" ? "DeepChest 服务可用" : "胸部 CT 分析完成",
      detail: pending ? phases[String(data.phase)] ?? "任务已提交，正在等待处理" : undefined,
      state: failed ? "failed" : pending ? "running" : "completed",
      ...(failed ? { severity: "error" as const } : {}),
    };
  }
  if (toolName === "med_dicom_route" || toolName === "med_image_route") {
    const modality = safeActivityValue(data.modality, "未知模态");
    const region = safeActivityValue(data.body_region, "未知部位");
    const skill = safeActivityValue(data.recommended_skill, "暂无推荐流程");
    const complete = data.is_3d_volume === true
      ? "三维文件头有效，检查完整性未确认"
      : data.is_complete_3d_series === true ? "三维序列完整" : "序列完整性未确认";
    return {
      title: toolName === "med_image_route" ? "影像预检完成" : "DICOM 路由完成",
      detail: `已识别 ${modality} / ${region}；${complete}；${data.recommended_skill ? `建议 ${skill}` : skill}`,
      state: data.status === "error" ? "failed" : "completed",
      ...(data.status === "degraded" || data.status === "error"
        ? { severity: data.status === "error" ? "error" as const : "warning" as const }
        : {}),
    };
  }
  if (toolName === "med_parse_medical") {
    const unsupportedNifti = data.vlm_error === "unsupported NIfTI";
    const itemCount = arrayLength(data.items);
    const frameCount = arrayLength(data.png_paths);
    const hasReport = typeof data.report === "string" && data.report.trim().length > 0;
    const degraded = data.status === "degraded" || data.status === "error";
    return {
      title: unsupportedNifti ? "NIfTI 无法通用解析" : degraded ? "医学附件已降级解析" : "医学附件解析完成",
      detail: `已解析 ${itemCount} 个附件，准备 ${frameCount} 张关键帧；${hasReport ? "医学报告已生成" : data.vlm_error === "unsupported NIfTI" ? "NIfTI 不支持通用解析" : "等待主智能体继续解读"}`,
      state: data.status === "error" ? "failed" : "completed",
      ...(degraded ? { severity: data.status === "error" ? "error" as const : "warning" as const } : {}),
    };
  }
  if (toolName === "med_radar_status") {
    const ready = data.ready === true;
    return {
      title: ready ? "RADAR 服务可用" : "RADAR 服务未就绪",
      detail: ready ? "模型与运行环境检查通过" : "请根据最终提示检查服务配置",
      state: ready ? "completed" : "failed",
      ...(!ready ? { severity: "error" as const } : {}),
    };
  }
  const transfer = data.transfer && typeof data.transfer === "object" && !Array.isArray(data.transfer)
    ? data.transfer as Record<string, unknown>
    : {};
  const selectedCases = typeof transfer.selected_cases === "number" ? transfer.selected_cases : 0;
  const ok = data.ok === true || data.status === "ready" || data.status === "completed";
  return {
    title: ok ? "RADAR 分析完成" : "RADAR 分析未完成",
    detail: ok ? `已完成 ${selectedCases || 1} 个 CT 检查并生成评分产物` : "请根据最终提示检查输入或服务状态",
    state: ok ? "completed" : "failed",
    ...(!ok ? { severity: "error" as const } : {}),
  };
}

/**
 * Tools whose plugin already generates user-facing prose (medical VLM) and
 * streams it via MCP progress into the assistant bubble.
 *
 * `endTurn` false: keep streaming, but let the agent loop continue (so a
 * follow-up like Word/PDF export can run in the same user turn).
 * `endTurn` true: also set `directFinalAssistantText` and finish the turn
 * without a second main-model rewrite.
 *
 * Pure medical interpretation streams and persists the original report.
 * Material mode emits activity only, then lets the main agent continue.
 */
const DIRECT_STREAM_FIELDS: Record<string, Record<string, { field: string; endTurn: boolean }>> = {
  "med-tools": {
    med_trauma_stage_plan: { field: "care_plan", endTurn: false },
    med_parse_medical: { field: "report", endTurn: true },
    med_deepchest_job: { field: "report", endTurn: true },
  },
};

const MEDICAL_MATERIAL_PRESENTATION = "本工具结果是内部分析材料，尚未作为最终答案展示。"
  + "最终交付中的影像判读保留 report 原文，主 Agent 只补充用户要求的综合分析或文件生成，不重复总结整份报告。"
  + "保留关键所见、部位、程度、重要阴性发现及不确定性，不要压缩为几句话；不补写材料中没有的征象。"
  + "report 是模型判读，summary 是解析资料；不得把疑似诊断改成确诊。若 report 为空或解析失败，说明限制并基于实际可用资料继续。"
  + "如用户还要求文件或其他交付，继续完成；不要仅回复报告已展示，也不要连续输出两份相同报告。";

function readContinuationMode(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).continuation_mode;
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function resolveDirectStreamEndTurn(
  streamSpec: { field: string; endTurn: boolean } | undefined,
  input: unknown,
  toolName: string,
): boolean {
  if (!streamSpec) return false;
  if (["med_parse_medical", "med_deepchest_job"].includes(toolName) && readContinuationMode(input) === "material") {
    return false;
  }
  return streamSpec.endTurn === true;
}

/** Exported for unit tests covering continuation_mode endTurn switching. */
export function shouldEndTurnAfterDirectStream(
  toolName: string,
  input: unknown,
  payloadContinuationMode?: unknown,
): boolean {
  const streamSpec = directStreamSpec("med-tools", toolName);
  const endTurn = resolveDirectStreamEndTurn(streamSpec, input, toolName);
  if (!endTurn) return false;
  if (
    typeof payloadContinuationMode === "string"
    && payloadContinuationMode.trim().toLowerCase() === "material"
  ) {
    return false;
  }
  return true;
}

function directStreamSpec(
  serverId: string,
  toolName: string,
): { field: string; endTurn: boolean } | undefined {
  return DIRECT_STREAM_FIELDS[serverId]?.[toolName];
}

function extractJsonTextPayload(raw: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const block of raw as McpContentBlock[]) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not every MCP text result is JSON.
    }
  }
  return undefined;
}

type McpContentBlock = { type: string; [key: string]: unknown };

function declaredCapabilities(
  capabilities: PilotDeckMcpToolCapabilities,
): readonly PilotDeckCapability[] {
  const declared: PilotDeckCapability[] = [];
  for (const root of capabilities.taskReadRoots) {
    declared.push({ kind: "task.read", root });
  }
  for (const root of capabilities.taskWriteRoots) {
    declared.push({ kind: "task.write", root });
  }
  for (const id of capabilities.networkServiceIds) {
    declared.push({ kind: "network", id });
  }
  return declared;
}

function requiredCapabilities(
  capabilities: PilotDeckMcpToolCapabilities,
): readonly PilotDeckCapability[] {
  const required: PilotDeckCapability[] = [];
  for (const root of capabilities.taskReadRoots) {
    required.push({ kind: "task.read", root });
  }
  for (const root of capabilities.taskWriteRoots) {
    required.push({ kind: "task.write", root });
  }
  for (const id of capabilities.networkServiceIds) {
    required.push({ kind: "network", id });
  }
  return required;
}

type McpArtifactCandidate = {
  path: string;
  role?: "final" | "intermediate";
  mimeType?: string;
  description?: string;
};

type ManagedDerivedArtifact = {
  name: string;
  mimeType?: string;
  description?: string;
};

type ExtractedMcpArtifacts = {
  content: PilotDeckToolResultContent[];
  artifacts: PilotDeckToolArtifact[];
  managedDerivedArtifacts: ManagedDerivedArtifact[];
};

async function extractMcpArtifacts(
  serverId: string,
  toolName: string,
  payload: Record<string, unknown> | undefined,
  capabilities: PilotDeckMcpToolCapabilities | undefined,
  context: PilotDeckToolRuntimeContext,
): Promise<ExtractedMcpArtifacts> {
  const empty: ExtractedMcpArtifacts = {
    content: [],
    artifacts: [],
    managedDerivedArtifacts: [],
  };
  if (!payload) return empty;

  const candidates = collectMcpArtifactCandidates(serverId, toolName, payload, capabilities);
  if (candidates.length === 0) return empty;
  if (!capabilities || capabilities.artifactPolicy === "none") {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `MCP tool ${serverId}/${toolName} returned files without a registered artifact capability.`,
    );
  }

  const extracted: ExtractedMcpArtifacts = { ...empty };
  for (const candidate of candidates) {
    const pathValue = candidate.path.trim();
    if (!pathValue || pathValue.includes("\0")) {
      throw invalidMcpArtifact(serverId, toolName, "invalid file path.");
    }

    const expectedRole = artifactRoleForPolicy(capabilities.artifactPolicy);
    if (capabilities.artifactPolicy !== "managed_derived"
      && candidate.role !== undefined
      && candidate.role !== expectedRole) {
      throw invalidMcpArtifact(
        serverId,
        toolName,
        `artifact role must be ${expectedRole}.`,
      );
    }

    // Stand-alone bridge callers do not carry the Agent task root. Preserve
    // the legacy file content in that narrow compatibility path; Agent calls
    // always have taskRoot and use the structured contract below.
    if (!context.taskRoot) {
      if (capabilities.artifactPolicy === "managed_derived") {
        extracted.content.push({
          type: "file",
          path: pathValue,
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(candidate.description ? { description: candidate.description } : {}),
        });
      } else {
        extracted.content.push({
          type: "file",
          path: pathValue,
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(candidate.description ? { description: candidate.description } : {}),
        });
      }
      continue;
    }

    const resolved = resolveExistingMcpPath(pathValue, context);
    if (!resolved) {
      if (
        capabilities.artifactPolicy === "managed_derived"
        && isManagedDerivedPath(pathValue, context)
      ) {
        extracted.managedDerivedArtifacts.push({
          name: basename(pathValue),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(candidate.description ? { description: candidate.description } : {}),
        });
        continue;
      }
      throw invalidMcpArtifact(serverId, toolName, "output path is outside the current task.");
    }

    if (
      capabilities.artifactPolicy === "managed_derived"
      && isManagedDerivedPath(resolved, context)
    ) {
      extracted.managedDerivedArtifacts.push({
        name: basename(resolved),
        ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
        ...(candidate.description ? { description: candidate.description } : {}),
      });
      continue;
    }

    const relativePath = relative(realpathSync(context.taskRoot), resolved).replace(/\\/g, "/");
    if (!isTaskArtifactRolePath(relativePath, expectedRole)) {
      throw invalidMcpArtifact(
        serverId,
        toolName,
        `output path must be under ${expectedRole === "final" ? "exports/" : "scratch/"}.`,
      );
    }
    extracted.artifacts.push({
      path: relativePath,
      role: expectedRole,
      ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
      ...(candidate.description ? { description: candidate.description } : {}),
    });
  }
  return extracted;
}

function collectMcpArtifactCandidates(
  serverId: string,
  toolName: string,
  payload: Record<string, unknown>,
  capabilities: PilotDeckMcpToolCapabilities | undefined,
): McpArtifactCandidate[] {
  const rawArtifacts = payload.artifacts;
  if (Array.isArray(rawArtifacts)) {
    return rawArtifacts.flatMap((item): McpArtifactCandidate[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.path !== "string") return [];
      return [{
        path: record.path,
        ...(record.role === "final" || record.role === "intermediate" ? { role: record.role } : {}),
        ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
        ...(typeof record.label === "string"
          ? { description: record.label }
          : typeof record.description === "string" ? { description: record.description } : {}),
      }];
    });
  }

  if (serverId === "med-tools" && toolName === "med_radar_analyze_ct"
    && rawArtifacts && typeof rawArtifacts === "object" && !Array.isArray(rawArtifacts)) {
    const record = rawArtifacts as Record<string, unknown>;
    const candidates: McpArtifactCandidate[] = [];
    if (typeof record.scores_csv === "string") {
      candidates.push({
        path: record.scores_csv,
        mimeType: "text/csv",
        description: "RADAR 评分 CSV",
      });
    }
    if (typeof record.summary_json === "string") {
      candidates.push({
        path: record.summary_json,
        mimeType: "application/json",
        description: "RADAR 摘要 JSON",
      });
    }
    return candidates;
  }

  if (serverId === "med-tools" && toolName === "med_deepchest_job"
    && payload.status === "succeeded" && Array.isArray(rawArtifacts)) {
    return rawArtifacts.flatMap((item): McpArtifactCandidate[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      return typeof record.path === "string"
        ? [{
            path: record.path,
            ...(record.path.endsWith(".json")
              ? { mimeType: "application/json" }
              : { mimeType: "text/markdown" }),
            description: typeof record.label === "string" ? record.label : "DeepChest 分析产物",
          }]
        : [];
    });
  }

  // A profile with no artifact capability must not infer files from arbitrary
  // payload fields. The explicit `artifacts` contract above is the only
  // accepted MCP output surface.
  void capabilities;
  return [];
}

function artifactRoleForPolicy(
  policy: PilotDeckMcpArtifactPolicy,
): "final" | "intermediate" {
  return policy === "intermediate" ? "intermediate" : "final";
}

function resolveExistingMcpPath(
  value: string,
  context: PilotDeckToolRuntimeContext,
): string | undefined {
  if (!context.taskRoot) return undefined;
  const candidate = isAbsolute(value)
    ? resolvePath(value)
    : resolvePath(context.cwd, value);
  try {
    const real = realpathSync(candidate);
    const taskRoot = realpathSync(context.taskRoot);
    if (!isPathInside(taskRoot, real) || !statSync(real).isFile()) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

function isTaskArtifactRolePath(
  relativePath: string,
  role: "final" | "intermediate",
): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return role === "final"
    ? normalized.startsWith("exports/") && normalized.length > "exports/".length
    : normalized.startsWith("scratch/") && normalized.length > "scratch/".length;
}

function isManagedDerivedPath(
  value: string,
  context: PilotDeckToolRuntimeContext,
): boolean {
  const candidate = isAbsolute(value)
    ? resolvePath(value)
    : resolvePath(context.cwd, value);
  const env = context.env ?? process.env;
  const roots = [
    env.MED_DICOM_DERIVED_DIR,
    env.MED_DERIVED_DIR,
    env.MED_DEEPCHEST_OUTPUT_DIR,
    env.MED_RAG_MINERU_INGEST_ROOT,
    env.PILOT_HOME ? resolvePath(env.PILOT_HOME, "artifacts", "deepchest") : undefined,
    env.PILOT_HOME ? resolvePath(env.PILOT_HOME, "med-tools", "mineru-ingest") : undefined,
    context.taskRoot ? resolvePath(context.taskRoot, "derived") : undefined,
  ].filter((root): root is string => typeof root === "string" && root.length > 0);
  return roots.some((root) => {
    const normalizedRoot = (() => {
      try {
        return realpathSync(root);
      } catch {
        return resolvePath(root);
      }
    })();
    const normalizedCandidate = (() => {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    })();
    return isPathInside(normalizedRoot, normalizedCandidate);
  });
}

function invalidMcpArtifact(
  serverId: string,
  toolName: string,
  detail: string,
): PilotDeckToolRuntimeError {
  return new PilotDeckToolRuntimeError(
    "tool_execution_failed",
    `Invalid MCP artifact from ${serverId}/${toolName}: ${detail}`,
  );
}

/**
 * Map MCP `ContentBlock[]` → `PilotDeckToolResultContent[]`.
 *
 * `TextContent`  → `{ type: "text" }`
 * `ImageContent` → `{ type: "image" }` (renders inline in chat)
 * Everything else falls through as a single `json` block.
 *
 * When `cwd` is provided and no inline image block is present, the function
 * scans text blocks for Markdown image links (`[…](./file.png)`) and reads
 * the referenced files from disk so that screenshots taken with a
 * user-specified `filename` (which `@playwright/mcp` saves without returning
 * base64 data) still render inline in the chat UI.
 */
function marshalMcpContent(
  raw: unknown,
  cwd?: string,
  taskRoot?: string,
): PilotDeckToolResultContent[] {
  if (!Array.isArray(raw)) return [{ type: "json", value: raw }];

  const result: PilotDeckToolResultContent[] = [];
  const remainder: unknown[] = [];
  let hasImageBlock = false;

  for (const block of raw as McpContentBlock[]) {
    if (!block || typeof block !== "object" || typeof block.type !== "string") {
      remainder.push(block);
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      result.push({ type: "text", text: block.text });
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      result.push({ type: "image", mimeType: block.mimeType as string, data: block.data as string });
      hasImageBlock = true;
    } else {
      remainder.push(block);
    }
  }

  if (!hasImageBlock && cwd) {
    for (const block of raw as McpContentBlock[]) {
      if (block?.type === "text" && typeof block.text === "string") {
        const images = extractFileImages(block.text as string, cwd, taskRoot);
        for (const img of images) result.push(img);
      }
    }
  }

  if (remainder.length > 0) {
    result.push({ type: "json", value: remainder });
  }
  if (result.length === 0) {
    result.push({ type: "json", value: raw });
  }
  return result;
}

const IMAGE_LINK_RE = /\[.*?\]\((\.[^)]*\.(?:png|jpe?g|gif|webp))\)/gi;

/**
 * Extract image file references from Markdown text, read the files from disk,
 * and return them as base64 image blocks.
 */
function extractFileImages(
  text: string,
  cwd: string,
  taskRoot?: string,
): PilotDeckToolResultContent[] {
  const results: PilotDeckToolResultContent[] = [];
  for (const match of text.matchAll(IMAGE_LINK_RE)) {
    const relPath = match[1];
    try {
      const absPath = resolvePath(cwd, relPath);
      if (taskRoot) {
        const realPath = realpathSync(absPath);
        const realTaskRoot = realpathSync(taskRoot);
        if (!isPathInside(realTaskRoot, realPath) || !statSync(realPath).isFile()) continue;
      }
      const data = readFileSync(absPath);
      const ext = relPath.split(".").pop()?.toLowerCase() ?? "png";
      const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "gif" ? "image/gif"
        : ext === "webp" ? "image/webp"
        : "image/png";
      results.push({ type: "image", mimeType, data: data.toString("base64") });
    } catch {
      // File not readable — skip silently; the text link remains as-is.
    }
  }
  return results;
}

function extractMcpErrorText(
  content: unknown,
  serverId: string,
  toolName: string,
): string {
  const fallback = `MCP server ${serverId}/${toolName} returned isError`;
  if (!Array.isArray(content)) return fallback;
  const texts = content
    .filter(
      (block: unknown): block is { type: string; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: string }).text === "string",
    )
    .map((block) => block.text);
  if (texts.length === 0) return fallback;
  return texts.join("\n");
}

function normalizeSchema(raw: unknown): PilotDeckToolInputSchema {
  if (raw && typeof raw === "object") {
    const obj = raw as PilotDeckToolInputSchema;
    if (obj.type === "object") return obj;
  }
  return { type: "object", additionalProperties: true, properties: {} };
}
