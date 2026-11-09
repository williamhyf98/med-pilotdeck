import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstatSync, mkdirSync } from "node:fs";
import type { PilotDeckToolRuntimeContext } from "../../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";
import {
  acquireTaskProcess,
  assertScratchWithinLimit,
  resolveResourceLimits,
  type ResourceLimitOverrides,
} from "../../../security/policy/resourceLimits.js";
import { skillCacheEnv } from "./sandbox/grants.js";
import { resolveAppRoot } from "./sandbox/bwrap.js";
import type { PilotDeckCommandResult, PilotDeckCommandRunner } from "./commandRunner.js";
import { NodeShellCommandRunner } from "./commandRunner.js";

export type RegisteredExecutorOptions = {
  runner?: PilotDeckCommandRunner;
  timeoutMs?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  resourceLimits?: ResourceLimitOverrides;
  toolName?: string;
};

/**
 * Execute a server-built registered argv with the same task grants and
 * resource limits as the legacy Bash compatibility tool.
 */
export async function executeRegisteredCommand(
  file: string,
  args: string[],
  registeredTimeoutMs: number,
  context: PilotDeckToolRuntimeContext,
  options: RegisteredExecutorOptions = {},
): Promise<PilotDeckCommandResult> {
  const runner = options.runner ?? new NodeShellCommandRunner();
  if (!runner.runRegistered) {
    throw new PilotDeckToolRuntimeError(
      "automation_policy_violation",
      "Registered argv execution is unavailable.",
    );
  }

  const resourceLimits = resolveResourceLimits(options.resourceLimits);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const maxTimeoutMs = Math.min(
    options.maxTimeoutMs ?? resourceLimits.maxForegroundTimeoutMs,
    resourceLimits.maxForegroundTimeoutMs,
  );
  const requestedTimeoutMs = options.timeoutMs;
  if (requestedTimeoutMs !== undefined && requestedTimeoutMs > maxTimeoutMs) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Foreground document timeout ${requestedTimeoutMs}ms exceeds the maximum of ${maxTimeoutMs}ms.`,
    );
  }
  const timeoutMs = Math.max(
    1,
    requestedTimeoutMs ?? Math.min(defaultTimeoutMs, registeredTimeoutMs),
  );
  if (timeoutMs > registeredTimeoutMs) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Capability permits at most ${registeredTimeoutMs}ms.`,
    );
  }

  const temporary = join(context.cwd, "scratch", ".tmp");
  const candidateWorkDir = context.env?.PILOTDECK_WORK_DIR;
  const workDir = candidateWorkDir
    ? resolveWorkDir(candidateWorkDir, context.cwd)
    : undefined;
  assertScratchWithinLimit(context.cwd, resourceLimits);
  const releaseProcess = acquireTaskProcess(context.cwd, resourceLimits);
  let result: PilotDeckCommandResult;
  try {
    mkdirSync(temporary, { recursive: true });
    if (lstatSync(temporary).isSymbolicLink()) {
      throw new PilotDeckToolRuntimeError(
        "automation_policy_violation",
        "Task temporary directory cannot be a symlink.",
      );
    }

    const home = context.env?.PILOT_HOME ?? context.cwd;
    result = await runner.runRegistered(file, args, {
      cwd: context.cwd,
      taskRoot: context.cwd,
      env: {
        PATH: [
          join(resolveAppRoot(), ".runtime", "python", "bin"),
          dirname(process.execPath),
          "/usr/bin",
          "/bin",
          "/usr/local/bin",
          "/opt/homebrew/bin",
        ].join(":"),
        LANG: context.env?.LANG ?? "C.UTF-8",
        HOME: context.cwd,
        PILOT_HOME: context.cwd,
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
      onStdout: (chunk) => emitProgress(context, "stdout", chunk, options.toolName),
      onStderr: (chunk) => emitProgress(context, "stderr", chunk, options.toolName),
    });
  } finally {
    releaseProcess();
  }
  assertScratchWithinLimit(context.cwd, resourceLimits);
  return result;
}

function emitProgress(
  context: PilotDeckToolRuntimeContext,
  stream: "stdout" | "stderr",
  chunk: string,
  toolName = "registered_command",
): void {
  if (!context.progress || !chunk) return;
  try {
    context.progress({
      type: "tool_progress",
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.currentToolCallId ?? "",
      toolName,
      message: `${stream}: ${chunk.length} bytes`,
      metadata: { stream, chunk, byteCount: Buffer.byteLength(chunk, "utf8") },
      createdAt: (context.now?.() ?? new Date()).toISOString(),
    });
  } catch {
    // Progress is best effort and must not affect document generation.
  }
}

function resolveWorkDir(workDir: string, workspace: string): string {
  const resolvedWorkDir = resolve(workDir);
  const relativeWorkDir = relative(workspace, resolvedWorkDir);
  if (
    !relativeWorkDir
    || isAbsolute(relativeWorkDir)
    || relativeWorkDir.startsWith(`..${sep}`)
    || relativeWorkDir === ".."
    || relativeWorkDir.split(sep)[0] !== "scratch"
    || relativeWorkDir.split(sep)[1] !== "work"
    || hasSymlinkComponent(resolvedWorkDir, workspace)
  ) {
    throw new PilotDeckToolRuntimeError(
      "automation_policy_violation",
      "PILOTDECK_WORK_DIR must be inside the current task scratch/work directory.",
    );
  }
  return resolvedWorkDir;
}

function hasSymlinkComponent(target: string, root: string): boolean {
  const relativeTarget = relative(root, target);
  if (!relativeTarget || isAbsolute(relativeTarget) || relativeTarget.startsWith(`..${sep}`)) {
    return true;
  }
  let cursor = resolve(root);
  for (const part of relativeTarget.split(sep)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}
