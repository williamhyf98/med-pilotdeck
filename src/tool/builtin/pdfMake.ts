import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { PermissionResult } from "../../permission/index.js";
import { createSecurityPolicyStore } from "../../security/policy/PolicyStore.js";
import { resolveAppRoot } from "./bash/sandbox/bwrap.js";
import {
  evaluateStructuredCommand,
  type RegisteredBashCommand,
} from "./bash/registeredCommands.js";
import {
  executeRegisteredCommand,
  type RegisteredExecutorOptions,
} from "./bash/registeredExecutor.js";
import {
  extractRegisteredArtifacts,
  normalizeRegisteredOutput,
} from "./bash/registeredArtifacts.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";

export type PdfMakeInput = {
  title?: string;
  body?: string;
  body_file_path?: string;
  markdown_path?: string;
  author?: string;
  spec_path?: string;
  output_path: string;
  force?: boolean;
  timeout_ms?: number;
};

export type PdfMakeOutput = Readonly<{
  status: "ok";
  output: string;
  pages?: number;
  preview?: string[];
  audit?: string;
  warnings?: string[];
}>;

export type CreatePdfMakeToolOptions = RegisteredExecutorOptions;

export function createPdfMakeTool(
  options: CreatePdfMakeToolOptions = {},
): PilotDeckToolDefinition<PdfMakeInput, PdfMakeOutput> {
  return {
    name: "pdf_make",
    aliases: ["pdf.make"],
    title: "Create PDF",
    description:
      "根据文本、Markdown 或声明式 spec 创建新的 PDF。后端使用已登记的 PDF Skill，"
      + "输入和输出受当前任务目录约束；不要拼接 Bash、不要调用解释器或自行安装依赖。",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["output_path"],
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "PDF 标题。" },
        body: { type: "string", description: "简短正文。" },
        body_file_path: { type: "string", description: "任务内声明式正文文件路径，映射到 --body-file。" },
        markdown_path: { type: "string", description: "任务内 Markdown 文件路径，映射到 --markdown。" },
        author: { type: "string", description: "PDF 作者。" },
        spec_path: { type: "string", description: "任务内 JSON spec 文件路径，映射到 --spec。" },
        output_path: { type: "string", description: "PDF 输出路径，通常位于 exports/。" },
        force: { type: "boolean", description: "仅明确要求覆盖已有文件时设为 true。" },
        timeout_ms: { type: "integer", description: "可选前台超时时间，最大 600000 毫秒。" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["status", "output"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["ok"] },
        output: { type: "string" },
        pages: { type: "integer" },
        preview: { type: "array", items: { type: "string" } },
        audit: { type: "string" },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: (input) => input.force === true,
    isOpenWorld: () => false,
    validateInput: async (input) => validatePdfMakeInput(input),
    checkPermissions: async (input, context) => checkPdfMakePermissions(input, context),
    execute: async (input, context) => executePdfMake(input, context, options),
  };
}

async function validatePdfMakeInput(input: PdfMakeInput) {
  const issues: Array<{ path: string; code: "invalid_schema"; message: string }> = [];
  if (extname(input.output_path).toLowerCase() !== ".pdf") {
    issues.push({
      path: "output_path",
      code: "invalid_schema",
      message: "output_path must end with .pdf.",
    });
  }
  if (
    input.timeout_ms !== undefined
    && (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 600_000)
  ) {
    issues.push({
      path: "timeout_ms",
      code: "invalid_schema",
      message: "timeout_ms must be between 1 and 600000.",
    });
  }
  if (input.body_file_path && input.markdown_path) {
    issues.push({
      path: "body_file_path",
      code: "invalid_schema",
      message: "body_file_path and markdown_path cannot be used together.",
    });
  }
  return issues.length > 0
    ? { ok: false as const, issues }
    : { ok: true as const, input };
}

function checkPdfMakePermissions(
  input: PdfMakeInput,
  context: PilotDeckToolRuntimeContext,
): PermissionResult {
  try {
    resolvePdfMakeCommand(input, context);
    return {
      type: "allow",
      reason: { type: "safety", message: "Registered pdf.make capability is enabled." },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "deny", reason: { type: "safety", message }, message };
  }
}

async function executePdfMake(
  input: PdfMakeInput,
  context: PilotDeckToolRuntimeContext,
  options: CreatePdfMakeToolOptions,
): Promise<PilotDeckToolExecutionOutput<PdfMakeOutput>> {
  const registered = resolvePdfMakeCommand(input, context);
  if (registered.kind !== "script") {
    throw new PilotDeckToolRuntimeError(
      "automation_policy_violation",
      "pdf.make did not resolve to a registered Skill script.",
    );
  }
  const result = await executeRegisteredCommand(
    registered.file,
    registered.args,
    registered.timeoutMs,
    context,
    {
      ...options,
      timeoutMs: input.timeout_ms,
    },
  );
  if (result.outputLimitExceeded) {
    throw new PilotDeckToolRuntimeError(
      "result_too_large",
      "PDF Skill output exceeded the configured limit.",
    );
  }
  if (result.timedOut) {
    throw new PilotDeckToolRuntimeError(
      "tool_timeout",
      `PDF generation timed out after ${input.timeout_ms ?? 30_000}ms.`,
    );
  }
  if (result.exitCode !== 0) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `PDF Skill failed with exit code ${result.exitCode ?? "null"}: ${result.stderr || result.stdout}`,
      { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
    );
  }

  const normalized = normalizeRegisteredOutput(result.stdout, context.cwd);
  const payload = parsePdfPayload(normalized);
  if (!payload || payload.status !== "ok" || typeof payload.output !== "string") {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      "PDF Skill returned an invalid success payload.",
      { stdout: normalized, stderr: result.stderr },
    );
  }

  const output = resolvePilotDeckWorkspacePath(input.output_path, context, {
    forWrite: true,
    mustExist: true,
  });
  if (!output.ok) {
    throw new PilotDeckToolRuntimeError(output.error.code, output.error.message, output.error.details);
  }
  const outputStat = await stat(output.absolutePath).catch(() => undefined);
  if (!outputStat?.isFile()) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `PDF Skill did not create the requested output: ${output.relativePath}`,
    );
  }

  const artifacts = extractRegisteredArtifacts(result.stdout, context.cwd);
  if (!artifacts.some((artifact) => artifact.path === output.relativePath && artifact.role === "final")) {
    artifacts.unshift({
      path: output.relativePath,
      role: "final",
      mimeType: "application/pdf",
      description: "Generated PDF",
    });
  }
  return {
    content: [
      {
        type: "file",
        path: output.relativePath,
        mimeType: "application/pdf",
        description: "Generated PDF",
      },
      { type: "json", value: payload },
    ],
    artifacts,
    data: payload,
    metadata: {
      capability: "pdf.make",
      durationMs: result.durationMs,
      ...(result.stderr ? { stderr: result.stderr } : {}),
    },
  };
}

function resolvePdfMakeCommand(
  input: PdfMakeInput,
  context: PilotDeckToolRuntimeContext,
): Extract<RegisteredBashCommand, { kind: "script" }> {
  const values: Record<string, string | boolean> = {
    ...(input.title !== undefined ? { "--title": input.title } : {}),
    ...(input.body !== undefined ? { "--body": input.body } : {}),
    ...(input.body_file_path !== undefined ? { "--body-file": input.body_file_path } : {}),
    ...(input.markdown_path !== undefined ? { "--markdown": input.markdown_path } : {}),
    ...(input.author !== undefined ? { "--author": input.author } : {}),
    ...(input.spec_path !== undefined ? { "--spec": input.spec_path } : {}),
    "--out": input.output_path,
    ...(input.force ? { "--force": true } : {}),
  };
  const policy = createSecurityPolicyStore({ env: context.env }).getSnapshot().commands;
  const registered = evaluateStructuredCommand("pdf.make", values, {
    cwd: context.cwd,
    appRoot: resolveAppRoot(),
    policy,
    workDir: context.env?.PILOTDECK_WORK_DIR,
  });
  if (registered.kind !== "script") {
    throw new Error("pdf.make did not resolve to a registered Skill script.");
  }
  return registered;
}

function parsePdfPayload(value: string): PdfMakeOutput | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.status !== "ok" || typeof record.output !== "string") return undefined;
    return {
      status: "ok",
      output: record.output,
      ...(typeof record.pages === "number" ? { pages: record.pages } : {}),
      ...(Array.isArray(record.preview)
        ? { preview: record.preview.filter((item): item is string => typeof item === "string") }
        : {}),
      ...(typeof record.audit === "string" ? { audit: record.audit } : {}),
      ...(Array.isArray(record.warnings)
        ? { warnings: record.warnings.filter((item): item is string => typeof item === "string") }
        : {}),
    };
  } catch {
    return undefined;
  }
}
