import path from "node:path";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { ripgrepFiles } from "./filesystem/ripgrepFiles.js";

export type GlobInput = {
  pattern: string;
  path?: string;
  limit?: number;
};

export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string;
  relativePattern: string;
} {
  const match = pattern.match(/[*?[{]/);
  if (!match || match.index === undefined) {
    return {
      baseDir: path.dirname(pattern),
      relativePattern: path.basename(pattern),
    };
  }

  const staticPrefix = pattern.slice(0, match.index);
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf("/"),
    staticPrefix.lastIndexOf(path.sep),
  );

  if (lastSepIndex === -1) {
    return { baseDir: "", relativePattern: pattern };
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex);
  const relativePattern = pattern.slice(lastSepIndex + 1);

  if (baseDir === "" && lastSepIndex === 0) {
    baseDir = "/";
  }
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = `${baseDir}${path.sep}`;
  }

  return { baseDir, relativePattern };
}

export function createGlobTool(): PilotDeckToolDefinition<GlobInput> {
  return {
    name: "glob",
    aliases: ["Glob"],
    description:
      "限定在工作区内的快速文件名匹配工具。\n\n用法：\n- 支持 \"**/*.js\"、\"src/**/*.ts\" 这类 glob 模式。\n- 需要按文件名模式查找文件时使用本工具。\n- 可选的 path 参数用于把搜索范围限制在工作区内的某个子目录。\n- 返回的匹配路径顺序稳定且已排序。\n- 在读取或编辑文件之前，用本工具缩小候选文件范围。",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description:
            "用于匹配文件的 glob 模式。可以相对工作区、相对给定 path，"
            + "也可以是解析后仍位于工作区内的绝对路径 glob。",
        },
        path: {
          type: "string",
          description:
            "搜索所在目录。不填则使用工作区根目录；想用默认目录时直接省略该字段。若填写，必须解析为工作区内的目录。",
        },
        limit: {
          type: "integer",
          description:
            "最多返回的文件路径数量。这是 PilotDeck 特有的输出上限，默认 1000。截断前结果保持稳定排序。",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      let searchPath = input.path ?? ".";
      let searchPattern = input.pattern;

      if (path.isAbsolute(input.pattern)) {
        const extracted = extractGlobBaseDirectory(input.pattern);
        if (extracted.baseDir) {
          searchPath = extracted.baseDir;
          searchPattern = extracted.relativePattern;
        }
      }

      const resolvedSearchPath = resolvePilotDeckWorkspacePath(
        searchPath,
        context,
        { mustExist: true },
      );
      if (!resolvedSearchPath.ok) {
        throw new PilotDeckToolRuntimeError(
          resolvedSearchPath.error.code,
          resolvedSearchPath.error.message,
          resolvedSearchPath.error.details,
        );
      }

      const result = await ripgrepFiles({
        cwd: resolvedSearchPath.absolutePath,
        pattern: searchPattern,
        limit: input.limit,
        env: context.env,
        signal: context.abortSignal,
      });
      const workspacePrefix = resolvedSearchPath.relativePath === "." ? "" : `${resolvedSearchPath.relativePath}/`;
      const workspaceFiles = result.files.map((file) => `${workspacePrefix}${file}`);

      return {
        content: [{ type: "text", text: formatGlobResult(workspaceFiles, result.count, result.truncated, input.limit) }],
        data: {
          files: workspaceFiles,
          count: result.count,
          truncated: result.truncated,
        },
        metadata: { truncated: result.truncated },
      };
    },
  };
}

function formatGlobResult(files: string[], totalCount: number, truncated: boolean, limit: number | undefined): string {
  const lines = files.length > 0 ? [...files] : ["[No files matched]"];
  lines.push("", `[glob pagination] returned=${files.length} total=${totalCount} truncated=${truncated}${limit !== undefined ? ` limit=${limit}` : ""}`);
  if (truncated) {
    lines.push("More files are available. Narrow the pattern/path or call glob again with a higher limit if you need the full list.");
  }
  return lines.join("\n");
}
