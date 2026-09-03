import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { NodeShellCommandRunner, type PilotDeckCommandRunner } from "./bash/commandRunner.js";
import { classifyBashPermission, isReadOnlyShellCommand } from "./bash/permissions.js";

export type BashInput = {
  command: string;
  timeout?: number;
  description?: string;
};

export type CreateBashToolOptions = {
  runner?: PilotDeckCommandRunner;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
};

export type BashOutputState = "stdout_data" | "stderr_only" | "empty_stdout";

export type BashOutputAssertions = {
  commandSucceeded: boolean;
  stdoutVisible: boolean;
  stderrVisible: boolean;
  retrievedDataAvailable: boolean;
  stdoutBytes: number;
  stderrBytes: number;
};

export type BashOutput = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  outputState: BashOutputState;
  assertions: BashOutputAssertions;
};

const BASH_TOOL_DESCRIPTION = `在 PilotDeck 工作区内执行 shell 命令。

用法：
- \`command\` 参数会传给系统 shell（Windows 上是 \`cmd.exe\`，macOS/Linux 上是 \`/bin/sh\`）。
- shell 在当前工作区目录下运行，并继承工具运行时的环境变量。
- 用 \`timeout\` 覆盖命令超时时间，单位毫秒。不传时默认 30000ms，超过 600000ms 的取值会被拒绝。
- 用 \`description\` 给出简短清晰的中文说明，供日志与审计使用，用一句话说明这条命令做什么。
- 本工具用于本地的短小查看/文件管理命令，以及运行随附技能的入口脚本（例如 pdf.sh / docx.sh）。
- 所有转换类操作都必须走已注册工具或随附技能入口。若没有随附命令支持某项操作，请说明限制，不要自行另造实现。
- 只读命令（例如 \`pwd\`、\`ls\`、\`git status\`、\`git diff\`、\`git log\`）按只读处理；有副作用的命令需要授权；已知的危险命令会被直接拒绝。
- 离线部署：不要使用 curl、wget、pip install、npm install、npx 等对外联网或包管理器安装命令。缺少依赖时如实说明，不要尝试下载。
- 本工具返回 stdout、stderr、退出码和耗时。非零退出会抛出工具错误，超时会抛出 \`tool_timeout\`。
- 成功结果以 \`BASH_RESULT[success][...]\` 开头，并附带 Assertions。在把 \`exit_code: 0\` 当作任务进展之前，先看 \`retrieved_data_available\`：退出码 0 只说明进程执行成功，并不代表拿到了有用的数据。
- 若任务需要具体内容，但结果是 \`empty_stdout\` 或 \`stderr_only\`，应再执行一条命令把所需数据打印或校验出来，不要想当然地认为已有进展。
- 如果没有需要执行的命令，直接用文字回复，不要调用 bash。`;

const LONG_TASK_HINT =
  "Use timeout=600000 or less for foreground bash. Long-running commands may time out; keep skill script invocations bounded.";

const STREAM_DIAGNOSTIC_MAX_CHARS = 600;

const SHELL_BACKGROUND_WRAPPER_RE = /(?:^|[;&|]\s*|&&\s*|\|\|\s*|\$\(\s*)(?:nohup|disown|setsid)\b/iu;
const TRAILING_BACKGROUND_RE = /(?:^|[^&])&\s*(?:[)#}\]]\s*)?$/u;
const INLINE_BACKGROUND_RE = /(?:^|[;|]\s*)[^\n;&|]+&\s*(?:[;|]|&&|\|\|)/u;
const LONG_LIVED_COMMAND_PATTERNS = [
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/iu,
  /(?:^|\s)(?:vite|webpack(?:-dev-server)?|next|nuxt|astro|remix|svelte-kit)\b(?:[^\n]*\s(?:dev|start|preview|--host)\b|[^\n]*$)/iu,
  /(?:^|\s)(?:python(?:3)?\s+-m\s+http\.server|uvicorn|gunicorn|flask\s+run|streamlit\s+run|fastapi\s+dev)\b/iu,
  /(?:^|\s)(?:nodemon|tsx\s+watch|ts-node-dev|watchmedo)\b/iu,
  /(?:^|\s)(?:cargo\s+watch|watchexec|entr)\b/iu,
];

export function createBashTool(options?: CreateBashToolOptions): PilotDeckToolDefinition<BashInput, BashOutput> {
  const runner = options?.runner ?? new NodeShellCommandRunner();
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
  const maxTimeoutMs = options?.maxTimeoutMs ?? 600_000;

  return {
    name: "bash",
    aliases: ["Bash"],
    description: BASH_TOOL_DESCRIPTION,
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令（会传给系统 shell）。",
        },
        timeout: {
          type: "integer",
          description: "可选，超时时间，单位毫秒。默认 30000，最大 600000，更大的取值会被拒绝。前台 bash 请使用不超过 600000 的 timeout。离线部署会拒绝 curl、wget 以及包管理器安装类命令。",
        },
        description: {
          type: "string",
          description: "用一句简短清晰的中文说明这条命令做什么。",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: (input) => !input.command || isReadOnlyShellCommand(input.command),
    isConcurrencySafe: (input) => !input.command || isReadOnlyShellCommand(input.command),
    isOpenWorld: () => true,
    checkPermissions: async (input) => input.command ? classifyBashPermission(input.command) : ({ type: "allow" as const, reason: { type: "runtime" as const, message: "Empty command is safe" } }),
    execute: async (input, context) => {
      const command = input.command.trim();
      if (input.timeout !== undefined && input.timeout > maxTimeoutMs) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Foreground bash timeout ${input.timeout}ms exceeds the maximum of ${maxTimeoutMs}ms. ${LONG_TASK_HINT}`,
        );
      }
      const backgroundGuidance = foregroundBackgroundGuidance(command);
      if (backgroundGuidance) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", `${backgroundGuidance} ${LONG_TASK_HINT}`);
      }
      const timeoutMs = Math.max(1, input.timeout ?? defaultTimeoutMs);
      const progress = context.progress;
      const toolCallId = ""; // ToolRuntime fills this via metadata; we pull from context if available.
      const emitProgress = progress
        ? (stream: "stdout" | "stderr") => (chunk: string) => {
            try {
              progress({
                type: "tool_progress",
                sessionId: context.sessionId,
                turnId: context.turnId,
                toolCallId,
                toolName: "bash",
                message: `${stream}: ${chunk.length} bytes`,
                metadata: { stream, chunk, byteCount: Buffer.byteLength(chunk, "utf8") },
                createdAt: (context.now?.() ?? new Date()).toISOString(),
              });
            } catch {
              // Progress sinks are fire-and-forget; never crash the tool.
            }
          }
        : undefined;
      const result = await runner.run(command, {
        cwd: context.cwd,
        env: context.env,
        timeoutMs,
        signal: context.abortSignal,
        onStdout: emitProgress?.("stdout"),
        onStderr: emitProgress?.("stderr"),
      });

      if (result.timedOut) {
        throw new PilotDeckToolRuntimeError("tool_timeout", `Command timed out after ${timeoutMs}ms.`);
      }

      if (result.exitCode !== 0) {
        const summary = formatShellFailure(command, result);
        const diagnostic = formatShellFailureDiagnostic(result);
        throw new PilotDeckToolRuntimeError("tool_execution_failed", summary, {
          command,
          exitCode: result.exitCode,
          diagnostic,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
      }

      const assertions = buildBashOutputAssertions(result.stdout, result.stderr, result.exitCode);
      const outputState = classifyBashOutput(assertions);

      return {
        content: [
          {
            type: "text",
            text: formatShellResult(result.stdout, result.stderr, result.exitCode, outputState, assertions),
          },
        ],
        data: {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          outputState,
          assertions,
        },
      };
    },
  };
}

function buildBashOutputAssertions(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): BashOutputAssertions {
  const stdoutVisible = stdout.trim().length > 0;
  const stderrVisible = stderr.trim().length > 0;
  return {
    commandSucceeded: exitCode === 0,
    stdoutVisible,
    stderrVisible,
    retrievedDataAvailable: stdoutVisible,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
  };
}

function classifyBashOutput(assertions: BashOutputAssertions): BashOutputState {
  if (assertions.stdoutVisible) {
    return "stdout_data";
  }
  if (assertions.stderrVisible) {
    return "stderr_only";
  }
  return "empty_stdout";
}

function formatShellResult(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  outputState: BashOutputState,
  assertions: BashOutputAssertions,
): string {
  const lines = [
    `BASH_RESULT[success][${outputState}]`,
    "Assertions:",
    `- exit_code: ${exitCode ?? "null"}`,
    `- stdout_visible: ${assertions.stdoutVisible}`,
    `- stderr_visible: ${assertions.stderrVisible}`,
    `- retrieved_data_available: ${assertions.retrievedDataAvailable}`,
    `- stdout_bytes: ${assertions.stdoutBytes}`,
    `- stderr_bytes: ${assertions.stderrBytes}`,
    `Interpretation: ${bashOutputInterpretation(outputState)}`,
  ];

  if (assertions.stdoutVisible) {
    lines.push("", "stdout:", stdout.trimEnd());
  }
  if (assertions.stderrVisible) {
    lines.push("", "stderr:", stderr.trimEnd());
  }

  return lines.join("\n");
}

function bashOutputInterpretation(outputState: BashOutputState): string {
  switch (outputState) {
    case "stdout_data":
      return "Command succeeded and stdout contains visible data; use stdout as the primary evidence for the next step.";
    case "stderr_only":
      return "Command succeeded but stdout is empty; stderr contains diagnostic or progress output and does not count as retrieved task data by default.";
    case "empty_stdout":
      return "Command succeeded with no visible stdout or stderr; this only confirms process success and does not prove task data was retrieved.";
  }
}

function formatShellFailure(
  command: string,
  result: { exitCode: number | null; stdout: string; stderr: string },
): string {
  const lines: string[] = [];
  lines.push(`Command exited with code ${result.exitCode ?? "null"}: ${command}`);
  if (result.stderr.length > 0) {
    lines.push("", "stderr:", result.stderr.trimEnd());
  }
  if (result.stdout.length > 0) {
    lines.push("", "stdout:", result.stdout.trimEnd());
  }
  return lines.join("\n");
}

function formatShellFailureDiagnostic(
  result: { exitCode: number | null; stdout: string; stderr: string },
): string {
  const stream = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const traceback = parsePythonTraceback(stream);
  const moduleMissing = parseMissingModule(stream);
  const commandNotFound = parseCommandNotFound(stream);
  const syntaxError = parseSyntaxError(stream);

  const lines = [
    "BASH_FAILURE_DIAGNOSTIC",
    `- exit_code: ${result.exitCode ?? "null"}`,
  ];

  if (traceback) {
    lines.push(`- likely_cause: ${traceback.exception}`);
    if (traceback.location) lines.push(`- failing_location: ${traceback.location}`);
    lines.push("- next_step: inspect the failing file/line, fix that specific cause, then rerun the smallest command that exercises it.");
  } else if (moduleMissing) {
    lines.push(`- likely_cause: missing Python module ${moduleMissing}`);
    lines.push("- next_step: install the missing module if allowed, or rewrite the script to use available dependencies.");
  } else if (commandNotFound) {
    lines.push(`- likely_cause: command not found: ${commandNotFound}`);
    lines.push("- next_step: check whether the command is installed or use an available equivalent.");
  } else if (syntaxError) {
    lines.push(`- likely_cause: ${syntaxError}`);
    lines.push("- next_step: fix the syntax in the saved script or command, then rerun a minimal check.");
  } else {
    lines.push("- likely_cause: command exited non-zero; inspect stderr/stdout below for the root cause.");
    lines.push("- next_step: change the command or script before retrying; do not rerun unchanged.");
  }

  const stderrTail = tailSnippet(result.stderr, STREAM_DIAGNOSTIC_MAX_CHARS);
  if (stderrTail) lines.push("- stderr_tail:", indentBlock(stderrTail));
  const stdoutTail = tailSnippet(result.stdout, STREAM_DIAGNOSTIC_MAX_CHARS);
  if (stdoutTail && !stderrTail.includes(stdoutTail)) lines.push("- stdout_tail:", indentBlock(stdoutTail));
  return lines.join("\n");
}

function parsePythonTraceback(text: string): { exception: string; location?: string } | undefined {
  if (!/Traceback \(most recent call last\):/u.test(text)) return undefined;
  const lines = text.split(/\r?\n/);
  let location: string | undefined;
  for (const line of lines) {
    const match = /^\s*File "([^"]+)", line (\d+)(?:, in (.*))?/u.exec(line);
    if (match) {
      location = `${match[1]}:${match[2]}${match[3] ? ` in ${match[3].trim()}` : ""}`;
    }
  }
  const exception = [...lines].reverse().map((line) => line.trim()).find((line) => /^[A-Za-z_][\w.]*(?:Error|Exception|Warning)\b/u.test(line));
  return { exception: exception ?? "Python traceback", location };
}

function parseMissingModule(text: string): string | undefined {
  return /(?:ModuleNotFoundError|ImportError): No module named ['"]([^'"]+)['"]/u.exec(text)?.[1];
}

function parseCommandNotFound(text: string): string | undefined {
  return /(?:^|\n)(?:.*?:\s*)?([^\s:]+): command not found\b/u.exec(text)?.[1];
}

function parseSyntaxError(text: string): string | undefined {
  return /(?:^|\n)\s*(SyntaxError:[^\n]+)/u.exec(text)?.[1]?.trim();
}

function tailSnippet(value: string, maxChars: number): string {
  const trimmed = value.trimEnd();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `... [${trimmed.length - maxChars} chars omitted] ...\n${trimmed.slice(-maxChars)}`;
}

function indentBlock(value: string): string {
  return value.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}

function foregroundBackgroundGuidance(command: string): string | undefined {
  if (looksLikeHelpOrVersionCommand(command)) {
    return undefined;
  }

  const unquoted = stripQuotedText(command);
  if (SHELL_BACKGROUND_WRAPPER_RE.test(unquoted)) {
    return "Foreground bash command uses shell-level background wrappers (nohup/disown/setsid).";
  }
  if (INLINE_BACKGROUND_RE.test(unquoted) || TRAILING_BACKGROUND_RE.test(unquoted)) {
    return "Foreground bash command uses shell-level '&' backgrounding.";
  }
  if (LONG_LIVED_COMMAND_PATTERNS.some((pattern) => pattern.test(unquoted))) {
    return "Foreground bash command appears to start a long-lived server, watcher, or dev process.";
  }
  return undefined;
}

function looksLikeHelpOrVersionCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return /(?:^|\s)(?:--help|-h|help|--version|-v|version)\s*$/u.test(normalized);
}

function stripQuotedText(command: string): string {
  return command.replace(/(['"])(?:\\.|(?!\1).)*\1/gu, "").replace(/`(?:\\.|[^`])*`/gu, "");
}

export type { PilotDeckCommandOptions, PilotDeckCommandResult, PilotDeckCommandRunner } from "./bash/commandRunner.js";
