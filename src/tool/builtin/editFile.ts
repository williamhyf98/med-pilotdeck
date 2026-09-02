import { stat } from "node:fs/promises";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { isNotebookPath } from "./filesystem/fileTypeSafety.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { checkFilesystemWritePermission } from "./filesystem/writePermissions.js";
import { readTextFile } from "./filesystem/readTextFile.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";
import {
  ensureWriteSnapshotFresh,
  invalidateReadFileState,
  recordWriteSnapshot,
  validateWriteSnapshotFresh,
} from "./filesystem/writeSnapshots.js";
import { findActualString, normalizeEditInput } from "./filesystem/editNormalization.js";
import { formatSyntaxDiagnostics } from "./filesystem/syntaxDiagnostics.js";

export type EditFileInput = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export function createEditFileTool(): PilotDeckToolDefinition<EditFileInput> {
  return {
    name: "edit_file",
    aliases: ["Edit"],
    description:
      "通过精确字符串匹配替换，编辑工作区内的声明式文本文件；若要编辑工作区之外的文本文件，需先获得宿主明确授权。\n\n用法：\n- 用于文档内容和随附工具的输入，例如 Markdown、JSON、CSV、TSV 和纯文本。\n- 把 old_string 设为空字符串，可以直接创建一个新的声明式文件。\n- 编辑已存在的目标文件前，必须先用 read_file 读取；本会话中未读取过的已有文件，编辑会被拒绝。\n- old_string 必须与文件内容逐字符完全一致，包括缩进。请直接从 read_file 的输出中复制 old_string，不要增删空格。\n- 对已有声明式文件做定点修改时使用本工具。\n- 除非用 old_string: \"\" 创建新文件，否则 old_string 必须出现在目标文件中。\n- 若 old_string 不唯一，要么给出更具体的 old_string，要么设置 replace_all 以替换全部匹配。\n- 在同一文件中重命名或替换重复文本时使用 replace_all。\n- 工作区之外的路径在执行前需要用户明确授权。",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description: "要编辑的文件路径，可为相对路径或绝对路径。工作区之外的路径需要用户明确授权。",
        },
        old_string: {
          type: "string",
          description: "要查找并被替换的精确子串，必须出现在目标文件中。",
        },
        new_string: {
          type: "string",
          description: "用来替换 old_string 的新字符串。",
        },
        replace_all: {
          type: "boolean",
          description:
            "为 true 时替换 old_string 的全部匹配。默认 false，此时要求 old_string 在文件中唯一。",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    checkPermissions: async (input, context) =>
      checkFilesystemWritePermission("edit_file", input.file_path, context),
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

      if (isNotebookPath(resolved.absolutePath)) {
        return {
          ok: false,
          issues: [{
            path: "file_path",
            code: "invalid_schema",
            message: "File is a Jupyter notebook. Read it with read_file and rewrite it with write_file if a change is required; do not call a notebook-specific editor.",
          }],
        };
      }

      if (input.old_string !== "" && input.old_string === input.new_string) {
        return {
          ok: false,
          issues: [{
            path: "new_string",
            code: "invalid_schema",
            message: "old_string and new_string must differ.",
          }],
        };
      }

      let freshness: { exists: boolean };
      try {
        freshness = await validateWriteSnapshotFresh(context, resolved.absolutePath);
      } catch (error) {
        const normalized = error instanceof PilotDeckToolRuntimeError ? error.message : String(error);
        if (
          normalized === "File has not been read yet. Read it first before writing to it."
          || normalized === "File has changed since the last read. Read it again before writing to it."
        ) {
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

      if (!freshness.exists) {
        if (input.old_string === "") {
          return { ok: true, input };
        }
        return {
          ok: false,
          issues: [{
            path: "file_path",
            code: "invalid_schema",
            message: `File ${input.file_path} does not exist.`,
          }],
        };
      }

      if (input.old_string !== "") {
        return { ok: true, input };
      }

      const content = await readTextFile(resolved.absolutePath);
      if (content.length === 0) {
        return { ok: true, input };
      }

      return {
        ok: false,
        issues: [{
          path: "old_string",
          code: "invalid_schema",
          message: "old_string may be empty only when creating a new file or writing to an empty file.",
        }],
      };
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

      const content = freshness.previousContent ?? "";
      let occurrences = 0;
      let nextContent: string;

      if (input.old_string === "") {
        if (freshness.exists && content.length !== 0) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            "old_string may be empty only when creating a new file or writing to an empty file.",
          );
        }
        nextContent = input.new_string;
      } else {
        const { oldString: normalizedOld, newString: normalizedNew } =
          normalizeEditInput(resolved.absolutePath, input.old_string, input.new_string);
        const actualOldString = findActualString(content, normalizedOld);
        if (!actualOldString) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `String to replace not found in file.\nString: ${input.old_string}`,
          );
        }
        occurrences = countOccurrences(content, actualOldString);
        if (occurrences > 1 && !input.replace_all) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `Found ${occurrences} matches of old_string. Set replace_all to true to replace all occurrences, or provide a more specific old_string.`,
          );
        }
        nextContent = input.replace_all
          ? content.split(actualOldString).join(normalizedNew)
          : content.replace(actualOldString, normalizedNew);
      }

      const action = await writeTextFile(resolved.absolutePath, nextContent, { allowOverwrite: true });
      const fileStat = await stat(resolved.absolutePath);
      invalidateReadFileState(context, resolved.absolutePath);
      recordWriteSnapshot(context, resolved.absolutePath, nextContent, Math.floor(fileStat.mtimeMs));

      const update = {
        absolutePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
        root: resolved.root,
        content: nextContent,
        previousContent: freshness.previousContent,
      };
      await context.fileUpdateNotifier?.didChange?.(update);
      await context.fileUpdateNotifier?.didSave?.(update);

      const replacements = input.old_string === "" ? 0 : input.replace_all ? occurrences : 1;
      const successText =
        `${action === "created" ? "Created" : "Updated"} ${resolved.relativePath}${replacements > 0 ? ` (${replacements} replacement).` : "."}`;
      const syntaxDiagnostics = await formatSyntaxDiagnostics(resolved.relativePath, nextContent);
      return {
        content: [{
          type: "text",
          text: syntaxDiagnostics ? `${successText}\n\n${syntaxDiagnostics}` : successText,
        }],
        data: {
          filePath: resolved.relativePath,
          replacements,
          changed: action === "created" || nextContent !== content,
        },
        metadata: {
          bytesWritten: Buffer.byteLength(nextContent, "utf8"),
          mtimeMs: Math.floor(fileStat.mtimeMs),
        },
      };
    },
  };
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let index = value.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(search, index + search.length);
  }
  return count;
}
