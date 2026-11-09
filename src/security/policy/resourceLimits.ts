import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxForegroundTimeoutMs: 600_000,
  maxToolOutputBytes: 200_000,
  maxScratchBytes: 1024 * 1024 * 1024,
  maxChildProcesses: 1,
});

export type ResourceLimits = Readonly<{
  maxForegroundTimeoutMs: number;
  maxToolOutputBytes: number;
  maxScratchBytes: number;
  maxChildProcesses: number;
}>;

export type ResourceLimitOverrides = Partial<ResourceLimits>;

export class ResourceLimitError extends Error {
  constructor(
    public readonly kind: "scratch" | "child_process",
    message: string,
    public readonly details: Readonly<Record<string, number>> = {},
  ) {
    super(message);
    this.name = "ResourceLimitError";
  }
}

export function resolveResourceLimits(overrides: ResourceLimitOverrides = {}): ResourceLimits {
  const limits = {
    ...DEFAULT_RESOURCE_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Resource limit ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

/**
 * Count logical bytes below scratch without following symlinks.
 * Symlink targets are deliberately excluded because task path validation
 * rejects them separately and quota accounting must never traverse out.
 */
export function measureScratchBytes(taskRoot: string): number {
  const scratch = resolve(taskRoot, "scratch");
  const info = lstatSync(scratch);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ResourceLimitError("scratch", "Task scratch must be a real directory.");
  }
  return measureDirectoryBytes(scratch);
}

export function assertScratchWithinLimit(
  taskRoot: string,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): number {
  const usedBytes = measureScratchBytes(taskRoot);
  if (usedBytes > limits.maxScratchBytes) {
    throw new ResourceLimitError(
      "scratch",
      `Task scratch usage ${usedBytes} bytes exceeds the limit of ${limits.maxScratchBytes} bytes.`,
      { usedBytes, maxScratchBytes: limits.maxScratchBytes },
    );
  }
  return usedBytes;
}

const activeProcessCounts = new Map<string, number>();

/**
 * Reserve one task-scoped registered subprocess slot.
 * The returned release function is idempotent so timeout/cancel paths cannot
 * leak the slot or decrement a later invocation's count.
 */
export function acquireTaskProcess(
  taskRoot: string,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): () => void {
  const key = realpathSync(resolve(taskRoot));
  const active = activeProcessCounts.get(key) ?? 0;
  if (active >= limits.maxChildProcesses) {
    throw new ResourceLimitError(
      "child_process",
      `Task already has ${active} active registered child process(es); the limit is ${limits.maxChildProcesses}.`,
      { active, maxChildProcesses: limits.maxChildProcesses },
    );
  }
  activeProcessCounts.set(key, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (activeProcessCounts.get(key) ?? 1) - 1;
    if (next > 0) activeProcessCounts.set(key, next);
    else activeProcessCounts.delete(key);
  };
}

export function resetTaskProcessLimitsForTests(): void {
  activeProcessCounts.clear();
}

function measureDirectoryBytes(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      total += measureDirectoryBytes(path);
      continue;
    }
    if (info.isFile()) {
      total += info.size;
    }
  }
  return total;
}
