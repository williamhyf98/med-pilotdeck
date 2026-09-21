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
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from "node:path";

import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolInputSchema,
  PilotDeckToolResultContent,
} from "../../tool/index.js";
import type { McpClient } from "../client/McpClient.js";
import type { McpRuntime } from "./McpRuntime.js";
import type {
  PilotDeckMcpToolAnnotations,
  PilotDeckMcpToolSpec,
} from "../protocol/types.js";

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
  const isReadOnly = annotations.readOnlyHint === true;
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
    isConcurrencySafe: () => isReadOnly,
    isDestructive: () => isDestructive,
    isOpenWorld: () => isOpenWorld,
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput> => {
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
        const normalizedInput = normalizeMedicalToolInputPath(
          spec.serverId,
          spec.toolName,
          input,
          context.cwd,
        );
        const streamSpec = directStreamSpec(spec.serverId, spec.toolName);
        const medicalMaterial = medicalParser && readContinuationMode(normalizedInput) === "material";
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
        return {
          content: [
            ...marshalMcpContent(content, client.spec.transport === "stdio" ? client.spec.cwd : undefined),
            ...extractMedicalArtifactFiles(spec.serverId, spec.toolName, jsonPayload),
          ],
          data: parsedPayload ?? content,
          metadata: {
            mcp: { serverId: spec.serverId, toolName: spec.toolName, wireName: spec.wireName },
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
  "med_dicom_route",
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
): { title: string; detail?: string; state: "completed" | "failed"; severity?: "warning" | "error" } {
  const data = payload ?? {};
  if (toolName === "med_dicom_route") {
    const modality = safeActivityValue(data.modality, "未知模态");
    const region = safeActivityValue(data.body_region, "未知部位");
    const skill = safeActivityValue(data.recommended_skill, "med-medical");
    const complete = data.is_complete_3d_series === true ? "三维序列完整" : "序列完整性未确认";
    return {
      title: "DICOM 路由完成",
      detail: `已识别 ${modality} / ${region}；${complete}；建议 ${skill}`,
      state: "completed",
      ...(data.status === "degraded" ? { severity: "warning" as const } : {}),
    };
  }
  if (toolName === "med_parse_medical") {
    const itemCount = arrayLength(data.items);
    const frameCount = arrayLength(data.png_paths);
    const hasReport = typeof data.report === "string" && data.report.trim().length > 0;
    const degraded = data.status === "degraded" || data.status === "error";
    return {
      title: degraded ? "医学附件已降级解析" : "医学附件解析完成",
      detail: `已解析 ${itemCount} 个附件，准备 ${frameCount} 张关键帧；${hasReport ? "医学报告已生成" : "等待主智能体继续解读"}`,
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
 * Tools whose plugin already generates user-facing prose (G9-V-Med) and
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
  if (toolName === "med_parse_medical" && readContinuationMode(input) === "material") {
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

function extractMedicalArtifactFiles(
  serverId: string,
  toolName: string,
  payload: Record<string, unknown> | undefined,
): PilotDeckToolResultContent[] {
  if (serverId !== "med-tools" || toolName !== "med_radar_analyze_ct" || !payload) return [];
  const artifacts = payload.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return [];
  const record = artifacts as Record<string, unknown>;
  const definitions = [
    ["scores_csv", "text/csv", "RADAR 评分 CSV"],
    ["summary_json", "application/json", "RADAR 摘要 JSON"],
  ] as const;
  return definitions.flatMap(([key, mimeType, description]) => {
    const filePath = record[key];
    return typeof filePath === "string" && filePath.trim()
      ? [{ type: "file" as const, path: filePath, mimeType, description }]
      : [];
  });
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
function marshalMcpContent(raw: unknown, cwd?: string): PilotDeckToolResultContent[] {
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
        const images = extractFileImages(block.text as string, cwd);
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
function extractFileImages(text: string, cwd: string): PilotDeckToolResultContent[] {
  const results: PilotDeckToolResultContent[] = [];
  for (const match of text.matchAll(IMAGE_LINK_RE)) {
    const relPath = match[1];
    try {
      const absPath = resolvePath(cwd, relPath);
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
