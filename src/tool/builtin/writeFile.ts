import { stat } from "node:fs/promises";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { checkFilesystemWritePermission } from "./filesystem/writePermissions.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";
import {
  buildStructuredPatch,
  buildUnifiedDiff,
  type StructuredPatchHunk,
} from "./filesystem/structuredPatch.js";
import {
  ensureWriteSnapshotFresh,
  invalidateReadFileState,
  recordWriteSnapshot,
  validateWriteSnapshotFresh,
} from "./filesystem/writeSnapshots.js";
import { formatSyntaxDiagnostics } from "./filesystem/syntaxDiagnostics.js";

export type WriteFileInput = {
  file_path: string;
  content: string;
};

export type WriteFileOutput = {
  type: "create" | "update";
  filePath: string;
  content: string;
  structuredPatch: StructuredPatchHunk[];
  originalFile: string | null;
  gitDiff?: {
    path: string;
    diff: string;
  };
};

export function createWriteFileTool(): PilotDeckToolDefinition<WriteFileInput, WriteFileOutput> {
  return {
    name: "write_file",
    aliases: ["Write"],
    description:
      "在工作区内写入 UTF-8 声明式内容文件；若要写到工作区之外，需先获得宿主明确授权。\n\n用法：\n- 用于文档内容和随附工具的输入，例如 Markdown、JSON、CSV、TSV 和纯文本。\n- file_path 可以是相对当前工作区的路径，也可以是绝对路径。工作区之外的路径在执行前需要用户明确授权。\n- 可以直接创建新文件；如需确认文件不存在，用 ls/glob/git status 查看。\n- 目标文件已存在时，本工具会直接覆盖。\n- 写入已存在的文件前，必须先用 read_file 读取；未先读取会导致本次写入失败。\n- 若目标文件在上次读取之后发生了变化，本工具会失败，必须重新读取后再写入。\n- 修改已有的声明式文件时优先使用 edit_file。本工具只用于创建新文件或整体重写。\n- 返回的 filePath 始终是解析后的绝对路径。\n- 除非用户明确要求，或某个随附技能需要它作为输入，否则不要创建文档文件（*.md）或 README 文件。\n- 仅在用户明确要求时使用 emoji；未经要求不要把 emoji 写入文件。",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path", "content"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description:
            "要写入的文件路径，可以是相对当前工作区的路径或绝对路径。工作区之外的路径需要用户明确授权。",
        },
        content: {
          type: "string",
          description: "要写入该文件的内容。",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["type", "filePath", "content", "structuredPatch", "originalFile"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["create", "update"] },
        filePath: { type: "string" },
        content: { type: "string" },
        structuredPatch: {
          type: "array",
          items: {
            type: "object",
            required: ["oldStart", "oldLines", "newStart", "newLines", "lines"],
            additionalProperties: false,
            properties: {
              oldStart: { type: "integer" },
              oldLines: { type: "integer" },
              newStart: { type: "integer" },
              newLines: { type: "integer" },
              lines: {
                type: "array",
                items: {
                  type: "object",
                  required: ["type", "text"],
                  additionalProperties: false,
                  properties: {
                    type: { type: "string", enum: ["context", "delete", "add"] },
                    text: { type: "string" },
                  },
                },
              },
            },
          },
        },
        originalFile: { type: ["string", "null"] },
        gitDiff: {
          type: "object",
          required: ["path", "diff"],
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            diff: { type: "string" },
          },
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    checkPermissions: async (input, context) =>
      checkFilesystemWritePermission("write_file", input.file_path, context),
    validateInput: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, {
        forWrite: true,
        allowOutsideWorkspace: true,
      });
      if (!resolved.ok) {
        return {
          ok: false,
          issues: [{
            path: "file_path",
            code: "invalid_schema",
            message: resolved.error.message,
          }],
        };
      }

      try {
        await validateWriteSnapshotFresh(context, resolved.absolutePath);
      } catch (error) {
        const normalized = error instanceof PilotDeckToolRuntimeError ? error.message : String(error);
        if (normalized === "File has not been read yet. Read it first before writing to it."
          || normalized === "File has changed since the last read. Read it again before writing to it.") {
          return {
            ok: false,
            issues: [{
              path: "file_path",
              code: "invalid_schema",
              message: normalized,
            }],
          };
        }
        throw error;
      }

      return { ok: true, input };
    },
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, {
        forWrite: true,
        allowOutsideWorkspace: context.currentPermissionDecision?.type === "allow",
      });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const freshness = await ensureWriteSnapshotFresh(context, resolved.absolutePath);
      if (context.fileHistory) {
        await context.fileHistory.trackEdit(
          resolved.absolutePath,
          context.messageId ?? context.turnId,
        );
      }

      const action = await writeTextFile(resolved.absolutePath, input.content, { allowOverwrite: true });
      const fileStat = await stat(resolved.absolutePath);
      invalidateReadFileState(context, resolved.absolutePath);
      recordWriteSnapshot(context, resolved.absolutePath, input.content, Math.floor(fileStat.mtimeMs));

      const type = action === "created" ? "create" : "update";
      const structuredPatch = buildStructuredPatch(freshness.previousContent, input.content);
      const gitDiffText = buildUnifiedDiff(resolved.relativePath, freshness.previousContent, input.content);
      const data: WriteFileOutput = {
        type,
        filePath: resolved.absolutePath,
        content: input.content,
        structuredPatch,
        originalFile: freshness.previousContent,
        ...(gitDiffText ? { gitDiff: { path: resolved.relativePath, diff: gitDiffText } } : {}),
      };

      const update = {
        absolutePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
        root: resolved.root,
        content: input.content,
        previousContent: freshness.previousContent,
      };
      await context.fileUpdateNotifier?.didChange?.(update);
      await context.fileUpdateNotifier?.didSave?.(update);

      const successText = `${type === "create" ? "Created" : "Overwrote"} ${resolved.relativePath}.`;
      const syntaxDiagnostics = await formatSyntaxDiagnostics(resolved.relativePath, input.content);

      return {
        content: [{
          type: "text",
          text: syntaxDiagnostics ? `${successText}\n\n${syntaxDiagnostics}` : successText,
        }],
        data,
        metadata: {
          bytesWritten: Buffer.byteLength(input.content, "utf8"),
          mtimeMs: Math.floor(fileStat.mtimeMs),
        },
      };
    },
  };
}
