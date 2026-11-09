import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { NodeShellCommandRunner, type PilotDeckCommandRunner } from "./bash/commandRunner.js";
import { classifyBashPermission, isReadOnlyShellCommand } from "./bash/permissions.js";
import { createSecurityPolicyStore } from "../../security/policy/PolicyStore.js";
import { resolveAppRoot } from "./bash/sandbox/bwrap.js";
import { evaluateBashCommand } from "./bash/registeredCommands.js";
import { inspectWorkspace } from "./bash/workspaceInspection.js";
import { dirname, join, relative, resolve, sep } from "node:path";
import { lstatSync, mkdirSync } from "node:fs";
import { skillCacheEnv } from "./bash/sandbox/grants.js";
import {
  acquireTaskProcess,
  assertScratchWithinLimit,
  resolveResourceLimits,
  type ResourceLimitOverrides,
} from "../../security/policy/resourceLimits.js";
import { extractRegisteredArtifacts, normalizeRegisteredOutput } from "./bash/registeredArtifacts.js";

export type BashInput = {
  command: string;
  timeout?: number;
  description?: string;
};

export type CreateBashToolOptions = {
  runner?: PilotDeckCommandRunner;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  resourceLimits?: ResourceLimitOverrides;
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

const BASH_TOOL_DESCRIPTION = `执行系统已注册的工作区检查和文档 Skill 子命令。

用法：
- \`command\` 只接受单条注册命令：\`pwd\`、\`ls\`、\`stat\`、\`find\` 的受限工作区检查，或指定的文档 Skill 业务入口。
- 不调用通用 shell，不支持管道、重定向、命令拼接、环境变量赋值、任意解释器和未登记脚本。
- 文件输入只在当前任务的 inbox/scratch/exports，输出只在 scratch/exports；管理员配置可以进一步收紧。
- Skill 的内部 spec、检查和 QA 文件使用 \`$PILOTDECK_WORK_DIR\`，它只能指向当前任务的 \`scratch/work/\`。
- 用 \`timeout\` 覆盖命令超时时间，单位毫秒。不传时默认 30000ms，超过 600000ms 的取值会被拒绝。
- 用 \`description\` 给出简短清晰的中文说明，供日志与审计使用，用一句话说明这条命令做什么。
- 所有转换类操作都必须走已注册工具或随附技能入口。若没有随附命令支持某项操作，请说明限制，不要自行另造实现。
- 离线部署：缺少依赖时如实说明，不要尝试下载或安装。
- 本工具返回 stdout、stderr、退出码和耗时。非零退出会抛出工具错误，超时会抛出 \`tool_timeout\`。
- 成功结果以 \`BASH_RESULT[success][...]\` 开头，并附带 Assertions。在把 \`exit_code: 0\` 当作任务进展之前，先看 \`retrieved_data_available\`：退出码 0 只说明进程执行成功，并不代表拿到了有用的数据。
- 若任务需要具体内容，但结果是 \`empty_stdout\` 或 \`stderr_only\`，应使用 read_file、glob 或 grep 读取或校验，不要想当然地认为已有进展。
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
  const resourceLimits = resolveResourceLimits(options?.resourceLimits);
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
  const maxTimeoutMs = Math.min(
    options?.maxTimeoutMs ?? resourceLimits.maxForegroundTimeoutMs,
    resourceLimits.maxForegroundTimeoutMs,
  );

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
          description: "单条已注册的工作区检查命令或文档 Skill 业务子命令；不会传给通用 shell。",
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
    maxResultBytes: resourceLimits.maxToolOutputBytes,
    isReadOnly: (input) => !input.command || isReadOnlyShellCommand(input.command),
    isConcurrencySafe: (input) => !input.command || isReadOnlyShellCommand(input.command),
    isOpenWorld: () => true,
    checkPermissions: async (input, context) => {
      try {
        if (classifyBashPermission(input.command).type === "deny") {
          throw new Error("Dangerous shell command denied.");
        }
        resolveCommand(input.command, context.cwd, context.env);
        return { type: "allow" as const, reason: { type: "safety" as const, message: "Registered command is enabled." } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { type: "deny" as const, reason: { type: "safety" as const, message }, message };
      }
    },
    execute: async (input, context) => {
      const command = input.command.trim();
      let registered;
      try {
        registered = resolveCommand(command, context.cwd, context.env);
      } catch (error) {
        throw new PilotDeckToolRuntimeError("automation_policy_violation",
          error instanceof Error ? error.message : String(error));
      }
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
      const timeoutMs = Math.max(1, input.timeout ?? Math.min(defaultTimeoutMs, registered.timeoutMs));
      if (timeoutMs > registered.timeoutMs) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input",
          `Capability ${registered.id} permits at most ${registered.timeoutMs}ms.`);
      }
      const progress = context.progress;
      const toolCallId = context.currentToolCallId ?? "";
      const isDeepChestCommand = /(?:^|[/\\])run_deepchest_agent_qwen\.sh(?:\s|$)/u.test(command);
      const deepChestActivityId = `medical:${toolCallId || "deepchest"}`;
      const emitDeepChestActivity = (
        title: string,
        detail: string,
        state: "running" | "completed" | "failed",
      ) => {
        if (!progress || !isDeepChestCommand) return;
        progress({
          type: "tool_progress",
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId,
          toolName: "bash",
          message: title,
          metadata: {
            channel: "medical_activity",
            activityId: deepChestActivityId,
            phase: "medical",
            title,
            detail,
            state,
            ...(state === "failed" ? { severity: "error" } : {}),
          },
          createdAt: (context.now?.() ?? new Date()).toISOString(),
        });
      };
      emitDeepChestActivity(
        "正在检查 DeepChest 产物",
        "核对 DeepChestVQA、CT-CLIP 和分割结果",
        "running",
      );
      let deepChestExecutionReported = false;
      const emitProgress = progress
        ? (stream: "stdout" | "stderr") => (chunk: string) => {
            try {
              if (isDeepChestCommand && !deepChestExecutionReported && chunk.trim()) {
                deepChestExecutionReported = true;
                emitDeepChestActivity(
                  command.includes("--dry-run") ? "正在执行 DeepChest 预检" : "正在执行胸部 CT 流程",
                  command.includes("--dry-run") ? "验证数据、mask 和 CT-CLIP 产物" : "3DMedAgent 正在处理胸部 CT 证据",
                  "running",
                );
              }
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
      const result = registered.kind === "workspace"
        ? inspectWorkspace(registered, context.cwd)
        : await (async () => {
            if (!runner.runRegistered) {
              throw new PilotDeckToolRuntimeError("automation_policy_violation", "Registered argv execution is unavailable.");
            }
            const home = context.env?.PILOT_HOME ?? context.cwd;
            const temporary = join(context.cwd, "scratch", ".tmp");
            const candidateWorkDir = context.env?.PILOTDECK_WORK_DIR;
            const workDir = candidateWorkDir && (() => {
              const rel = relative(join(context.cwd, "scratch", "work"), resolve(candidateWorkDir));
              return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)
                ? resolve(candidateWorkDir)
                : undefined;
            })();
            assertScratchWithinLimit(context.cwd, resourceLimits);
            const releaseProcess = acquireTaskProcess(context.cwd, resourceLimits);
            try {
              mkdirSync(temporary, { recursive: true });
              if (lstatSync(temporary).isSymbolicLink()) {
                throw new PilotDeckToolRuntimeError("automation_policy_violation", "Task temporary directory cannot be a symlink.");
              }
              return await runner.runRegistered(registered.file, registered.args, {
                cwd: context.cwd,
                taskRoot: context.cwd,
                env: {
                  PATH: [join(resolveAppRoot(), ".runtime", "python", "bin"),
                    dirname(process.execPath), "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(":"),
                  LANG: context.env?.LANG ?? "C.UTF-8",
                  HOME: context.cwd, PILOT_HOME: context.cwd,
                  TMPDIR: temporary,
                  XDG_CACHE_HOME: join(context.cwd, "scratch", ".cache"),
                  PILOTDECK_WORKSPACE_DIR: context.cwd,
                  PILOTDECK_WORKSPACE_CWD: context.cwd,
                  ...(workDir ? { PILOTDECK_WORK_DIR: workDir } : {}),
                  ...skillCacheEnv(resolveAppRoot()),
                },
                userHome: home,
                timeoutMs,
                maxOutputBytes: resourceLimits.maxToolOutputBytes,
                signal: context.abortSignal,
                onStdout: emitProgress?.("stdout"),
                onStderr: emitProgress?.("stderr"),
              });
            } finally {
              releaseProcess();
            }
          })();
      const visibleResult = registered.kind === "script"
        ? {
            ...result,
            stdout: normalizeRegisteredOutput(result.stdout, context.cwd),
            stderr: normalizeRegisteredOutput(result.stderr, context.cwd),
          }
        : result;

      assertScratchWithinLimit(context.cwd, resourceLimits);
      if (visibleResult.outputLimitExceeded) {
        throw new PilotDeckToolRuntimeError(
          "result_too_large",
          `Command output exceeded the ${resourceLimits.maxToolOutputBytes}-byte limit and was terminated.`,
          { maxOutputBytes: resourceLimits.maxToolOutputBytes },
        );
      }
      if (visibleResult.timedOut) {
        emitDeepChestActivity("DeepChest 流程超时", "流程未完成，请检查最终错误提示", "failed");
        throw new PilotDeckToolRuntimeError("tool_timeout", `Command timed out after ${timeoutMs}ms.`);
      }

      if (visibleResult.exitCode !== 0) {
        emitDeepChestActivity("DeepChest 流程失败", "流程未完成，请检查最终错误提示", "failed");
        const summary = formatShellFailure(command, visibleResult);
        const diagnostic = formatShellFailureDiagnostic(visibleResult);
        throw new PilotDeckToolRuntimeError("tool_execution_failed", summary, {
          command,
          exitCode: visibleResult.exitCode,
          diagnostic,
          stdout: visibleResult.stdout,
          stderr: visibleResult.stderr,
          timedOut: visibleResult.timedOut,
          durationMs: visibleResult.durationMs,
        });
      }

      const assertions = buildBashOutputAssertions(
        visibleResult.stdout,
        visibleResult.stderr,
        visibleResult.exitCode,
      );
      const outputState = classifyBashOutput(assertions);
      emitDeepChestActivity(
        command.includes("--dry-run") ? "DeepChest 预检完成" : "DeepChest 分析完成",
        command.includes("--dry-run") ? "数据与中间产物检查已完成" : "胸部 CT 结果已生成并可供整理",
        "completed",
      );

      return {
        content: [
          {
            type: "text",
            text: formatShellResult(
              visibleResult.stdout,
              visibleResult.stderr,
              visibleResult.exitCode,
              outputState,
              assertions,
            ),
          },
        ],
        ...(registered.kind === "script"
          ? (() => {
              const artifacts = extractRegisteredArtifacts(result.stdout, context.cwd);
              return artifacts.length > 0 ? { artifacts } : {};
            })()
          : {}),
        data: {
          command,
          exitCode: visibleResult.exitCode,
          stdout: visibleResult.stdout,
          stderr: visibleResult.stderr,
          timedOut: visibleResult.timedOut,
          durationMs: visibleResult.durationMs,
          outputState,
          assertions,
        },
      };
    },
  };
}

function resolveCommand(command: string, cwd: string, env?: NodeJS.ProcessEnv) {
  const policy = createSecurityPolicyStore({ env }).getSnapshot().commands;
  return evaluateBashCommand(command, {
    cwd,
    appRoot: resolveAppRoot(),
    policy,
    workDir: env?.PILOTDECK_WORK_DIR,
  });
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
