import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PermissionResult } from "../../permission/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { appendAudit } from "../../security/audit/auditLog.js";

const DEFAULT_RENDERER_PORT = 19400;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

const OFFICE_PDF_FORMATS = {
  docx: {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  xlsx: {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  pptx: {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
} as const;

type OfficePdfExtension = keyof typeof OFFICE_PDF_FORMATS;

export type OfficeToPdfInput = {
  input_file: string;
  output_file: string;
  force?: boolean;
  timeout_ms?: number;
};

export type OfficeToPdfOutput = {
  inputFile: string;
  outputFile: string;
  inputFormat: OfficePdfExtension;
  outputFormat: "pdf";
  renderer: string;
  bytes: number;
  sha256: string;
};

export function getOfficeRendererUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = String(environment.PILOTDECK_OFFICE_RENDERER_URL || "")
    .trim()
    .replace(/\/+$/u, "");
  if (configured) return configured;

  const role = String(environment.PILOTDECK_OFFICE_RENDERER_ROLE || "")
    .trim()
    .toLowerCase();
  if (role === "server") {
    const port = parsePositiveInteger(
      environment.PILOTDECK_OFFICE_RENDERER_PORT,
      DEFAULT_RENDERER_PORT,
    );
    return `http://127.0.0.1:${port}`;
  }

  return "";
}

export function createOfficeToPdfTool(): PilotDeckToolDefinition<
  OfficeToPdfInput,
  OfficeToPdfOutput
> {
  return {
    name: "office_to_pdf",
    title: "Convert Office File to PDF",
    description:
      "将工作区内已有的 DOCX、XLSX 或 PPTX 文件转换为 PDF，并保留 Office 文件的分页和布局。"
      + "Mac 与 node12 都通过已配置的 Office Renderer 执行，LibreOffice 只在 Renderer 服务端运行。"
      + "需要已有 Office 文件转 PDF 时直接使用本工具；不要使用 pdf.sh make 重排 Office 内容，"
      + "不要直接调用 soffice 或 LibreOffice。输入和输出必须是不同文件；默认不覆盖已有 PDF。",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["input_file", "output_file"],
      additionalProperties: false,
      properties: {
        input_file: {
          type: "string",
          description: "工作区内已有的 .docx、.xlsx 或 .pptx 文件路径。",
        },
        output_file: {
          type: "string",
          description: "工作区内的 PDF 输出路径，必须以 .pdf 结尾，通常放在 exports/ 下。",
        },
        force: {
          type: "boolean",
          description: "仅用户明确要求替换已有 PDF 时设为 true。",
        },
        timeout_ms: {
          type: "integer",
          description: "可选转换超时时间，默认 180000，最大 600000 毫秒。",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: [
        "inputFile",
        "outputFile",
        "inputFormat",
        "outputFormat",
        "renderer",
        "bytes",
        "sha256",
      ],
      additionalProperties: false,
      properties: {
        inputFile: { type: "string" },
        outputFile: { type: "string" },
        inputFormat: { type: "string", enum: Object.keys(OFFICE_PDF_FORMATS) },
        outputFormat: { type: "string", enum: ["pdf"] },
        renderer: { type: "string" },
        bytes: { type: "integer" },
        sha256: { type: "string" },
      },
    },
    checkAvailability: ({ env }) => {
      const renderer = getOfficeRendererUrl(env ?? process.env);
      return renderer
        ? { ok: true }
        : {
            ok: false,
            code: "setup_required",
            reason:
              "Office Renderer is not configured. Set PILOTDECK_OFFICE_RENDERER_URL "
              + "or use PILOTDECK_OFFICE_RENDERER_ROLE=server.",
          };
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    checkPermissions: async (input, context) =>
      checkOfficeToPdfPermissions(input, context),
    validateInput: async (input, context) => validateOfficeToPdfInput(input, context),
    execute: async (input, context) => executeOfficeToPdf(input, context),
  };
}

async function validateOfficeToPdfInput(
  input: OfficeToPdfInput,
  context: PilotDeckToolRuntimeContext,
) {
  const source = resolveSource(input.input_file, context);
  if (!source.ok) {
    return {
      ok: false as const,
      issues: [{
        path: "input_file",
        code: "invalid_schema" as const,
        message: source.error.message,
      }],
    };
  }

  const format = getOfficePdfExtension(source.absolutePath);
  if (!format) {
    return {
      ok: false as const,
      issues: [{
        path: "input_file",
        code: "invalid_schema" as const,
        message: "input_file must end with .docx, .xlsx, or .pptx.",
      }],
    };
  }

  const output = resolvePilotDeckWorkspacePath(input.output_file, context, { forWrite: true });
  if (!output.ok) {
    return {
      ok: false as const,
      issues: [{
        path: "output_file",
        code: "invalid_schema" as const,
        message: output.error.message,
      }],
    };
  }

  if (path.extname(output.absolutePath).toLowerCase() !== ".pdf") {
    return {
      ok: false as const,
      issues: [{
        path: "output_file",
        code: "invalid_schema" as const,
        message: "output_file must end with .pdf.",
      }],
    };
  }

  if (source.absolutePath === output.absolutePath) {
    return {
      ok: false as const,
      issues: [{
        path: "output_file",
        code: "invalid_schema" as const,
        message: "input_file and output_file must be different files.",
      }],
    };
  }

  if (input.timeout_ms !== undefined
    && (input.timeout_ms < 1 || input.timeout_ms > MAX_TIMEOUT_MS)) {
    return {
      ok: false as const,
      issues: [{
        path: "timeout_ms",
        code: "invalid_schema" as const,
        message: `timeout_ms must be between 1 and ${MAX_TIMEOUT_MS}.`,
      }],
    };
  }

  const sourceStat = await stat(source.absolutePath).catch(() => null);
  if (!sourceStat?.isFile()) {
    return {
      ok: false as const,
      issues: [{
        path: "input_file",
        code: "invalid_schema" as const,
        message: `Input file does not exist: ${source.relativePath}.`,
      }],
    };
  }
  if (sourceStat.size > MAX_INPUT_BYTES) {
    return {
      ok: false as const,
      issues: [{
        path: "input_file",
        code: "invalid_schema" as const,
        message: `Input file exceeds the ${MAX_INPUT_BYTES} byte limit.`,
      }],
    };
  }

  const outputStat = await stat(output.absolutePath).catch(() => null);
  if (outputStat && !outputStat.isFile()) {
    return {
      ok: false as const,
      issues: [{
        path: "output_file",
        code: "invalid_schema" as const,
        message: `Output path is not a file: ${output.relativePath}.`,
      }],
    };
  }
  if (outputStat && !input.force) {
    return {
      ok: false as const,
      issues: [{
        path: "output_file",
        code: "invalid_schema" as const,
        message: "Output already exists; set force=true only when replacement is requested.",
      }],
    };
  }

  return { ok: true as const, input };
}

function checkOfficeToPdfPermissions(
  input: OfficeToPdfInput,
  context: PilotDeckToolRuntimeContext,
): PermissionResult {
  const source = resolveSource(input.input_file, context);
  if (!source.ok) {
    return {
      type: "deny",
      reason: { type: "safety", message: source.error.message },
      message: source.error.message,
    };
  }

  const output = resolvePilotDeckWorkspacePath(input.output_file, context, { forWrite: true });
  if (!output.ok) {
    return {
      type: "deny",
      reason: { type: "safety", message: output.error.message },
      message: output.error.message,
    };
  }

  // spec §4.2 #6 / §6.1：覆盖已存在的产物要先确认。
  // `write_file` / `edit_file` 由"写前必读 + 内容哈希"的新鲜度校验拦住（见 writeSnapshots.ts），
  // 只有 office_to_pdf 直接落盘，所以覆盖确认只在这里补。
  if (existsSync(output.absolutePath)) {
    const message = `输出文件已存在，本次转换会覆盖它：${output.relativePath}`;
    const reason = { type: "tool" as const, toolName: "office_to_pdf", message };
    appendAudit(
      {
        action: "file.overwrite_ask",
        decision: "ask",
        tool: "office_to_pdf",
        target: output.relativePath,
        reason: "output-exists",
        meta: { mode: context.permissionMode },
      },
      { env: context.env ?? process.env },
    );
    return {
      type: "ask",
      reason,
      request: {
        toolCallId: "",
        toolName: "office_to_pdf",
        inputSummary: JSON.stringify({ input_file: input.input_file, output_file: output.relativePath }),
        reason,
        options: [
          {
            id: "allow_session",
            label: "Allow this folder for this session",
            rules: [{
              source: "session" as const,
              behavior: "allow" as const,
              toolName: "office_to_pdf" as const,
              pattern: path.join(path.dirname(output.absolutePath), "*"),
            }],
          },
          { id: "allow_once", label: "Allow once" },
          { id: "deny", label: "Deny" },
          { id: "cancel", label: "Cancel" },
        ],
        metadata: { overwriteTarget: output.relativePath },
      },
    };
  }

  return { type: "passthrough" };
}

async function executeOfficeToPdf(
  input: OfficeToPdfInput,
  context: PilotDeckToolRuntimeContext,
): Promise<{
  content: [
    { type: "file"; path: string; mimeType: "application/pdf"; description: string },
    { type: "json"; value: OfficeToPdfOutput },
  ];
  data: OfficeToPdfOutput;
}> {
  const source = resolveSourceOrThrow(input.input_file, context);
  const output = resolveOutputOrThrow(input.output_file, context);
  const format = getOfficePdfExtension(source.absolutePath);
  if (!format) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "input_file must end with .docx, .xlsx, or .pptx.",
    );
  }

  const sourceStat = await stat(source.absolutePath);
  if (!sourceStat.isFile()) {
    throw new PilotDeckToolRuntimeError(
      "file_not_found",
      `Input file does not exist: ${source.relativePath}.`,
    );
  }
  if (sourceStat.size > MAX_INPUT_BYTES) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Input file exceeds the ${MAX_INPUT_BYTES} byte limit.`,
    );
  }

  const existingOutput = await stat(output.absolutePath).catch(() => null);
  if (existingOutput && !input.force) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "Output already exists; set force=true only when replacement is requested.",
    );
  }

  const renderer = getOfficeRendererUrl(context.env ?? process.env);
  if (!renderer) {
    throw new PilotDeckToolRuntimeError(
      "setup_required",
      "Office Renderer is not configured.",
    );
  }

  const body = await readFile(source.absolutePath, { signal: context.abortSignal });
  const fileName = makeRendererFileName(source.absolutePath, format);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  );

  let pdf: Buffer;
  try {
    const token = String((context.env ?? process.env).PILOTDECK_OFFICE_RENDERER_TOKEN || "").trim();
    const response = await fetch(`${renderer}/v1/convert/pdf`, {
      method: "POST",
      body,
      signal: controller.signal,
      headers: {
        "Content-Type": OFFICE_PDF_FORMATS[format].mimeType,
        "X-File-Name": fileName,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      let detail = responseBody.toString("utf8").trim();
      try {
        const parsed = JSON.parse(detail) as { error?: string; code?: string };
        detail = parsed.error || detail;
      } catch {
        // Preserve the Renderer response when it is not JSON.
      }
      throw new PilotDeckToolRuntimeError(
        response.status >= 500 ? "tool_execution_failed" : "invalid_tool_input",
        `Office Renderer rejected ${format.toUpperCase()}: HTTP ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ""}`,
      );
    }
    if (!responseBody.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new PilotDeckToolRuntimeError(
        "tool_execution_failed",
        "Office Renderer returned an invalid PDF payload.",
      );
    }
    pdf = responseBody;
  } catch (error) {
    if (error instanceof PilotDeckToolRuntimeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PilotDeckToolRuntimeError(
      controller.signal.aborted ? "tool_timeout" : "tool_execution_failed",
      controller.signal.aborted
        ? `Office Renderer timed out after ${input.timeout_ms ?? DEFAULT_TIMEOUT_MS} ms.`
        : `Office Renderer request failed: ${message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  await mkdir(path.dirname(output.absolutePath), { recursive: true });
  const temporaryOutput = `${output.absolutePath}.${process.pid}.${Date.now()}.tmp.pdf`;
  try {
    await writeFile(temporaryOutput, pdf, { mode: 0o600 });
    await rename(temporaryOutput, output.absolutePath);
  } finally {
    await rm(temporaryOutput, { force: true }).catch(() => {});
  }

  const result: OfficeToPdfOutput = {
    inputFile: source.relativePath,
    outputFile: output.relativePath,
    inputFormat: format,
    outputFormat: "pdf",
    renderer,
    bytes: pdf.length,
    sha256: createHash("sha256").update(pdf).digest("hex"),
  };

  return {
    content: [
      {
        type: "file",
        path: output.relativePath,
        mimeType: "application/pdf",
        description: `Converted ${format.toUpperCase()} to PDF`,
      },
      { type: "json", value: result },
    ],
    data: result,
  };
}

function resolveSource(
  inputPath: string,
  context: PilotDeckToolRuntimeContext,
) {
  return resolvePilotDeckWorkspacePath(inputPath, context, {
    mustExist: true,
    allowRegisteredReadFiles: true,
  });
}

function resolveSourceOrThrow(
  inputPath: string,
  context: PilotDeckToolRuntimeContext,
) {
  const resolved = resolveSource(inputPath, context);
  if (!resolved.ok) {
    throw new PilotDeckToolRuntimeError(
      resolved.error.code,
      resolved.error.message,
      resolved.error.details,
    );
  }
  return resolved;
}

function resolveOutputOrThrow(
  outputPath: string,
  context: PilotDeckToolRuntimeContext,
) {
  const resolved = resolvePilotDeckWorkspacePath(outputPath, context, { forWrite: true });
  if (!resolved.ok) {
    throw new PilotDeckToolRuntimeError(
      resolved.error.code,
      resolved.error.message,
      resolved.error.details,
    );
  }
  if (path.extname(resolved.absolutePath).toLowerCase() !== ".pdf") {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "output_file must end with .pdf.",
    );
  }
  return resolved;
}

function getOfficePdfExtension(filePath: string): OfficePdfExtension | undefined {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return extension in OFFICE_PDF_FORMATS
    ? extension as OfficePdfExtension
    : undefined;
}

function makeRendererFileName(
  sourcePath: string,
  format: OfficePdfExtension,
): string {
  const basename = path.basename(sourcePath);
  return /^[\x20-\x7e]+$/u.test(basename)
    ? basename
    : `input.${format}`;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
