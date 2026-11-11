import { statSync } from "node:fs";
import type { PilotPathEnv } from "../../pilot/paths.js";
import { resolveSecurityPolicyPaths } from "./paths.js";
import { createSecurityPolicyStore } from "./PolicyStore.js";
import type { CommandPolicy } from "./parseCommandPolicy.js";

/**
 * 运行期的命令策略读取（spec §10.4.1）。
 *
 * `bash` 的权限判定是同步热路径，这里按"策略文件 mtime"缓存快照：
 * - 首次调用读一次；
 * - 管理员改了 `system/security/command-policy.yaml` → mtime 变化 → 自动重载，无需重启；
 * - **任何解析错误都不缓存成"允许"**：返回 `{ error }`，调用方据此回落 `ask`（fail-closed）。
 */

type Cache = {
  directory: string;
  mtimeMs: number;
  policy?: CommandPolicy;
  error?: string;
};

let cache: Cache | undefined;

export function currentCommandPolicy(
  env: PilotPathEnv = process.env,
): { policy: CommandPolicy } | { error: string } {
  let paths;
  try {
    paths = resolveSecurityPolicyPaths(env);
  } catch (error) {
    return { error: message(error) };
  }

  const mtimeMs = mtimeOf(paths.command);
  if (cache && cache.directory === paths.directory && cache.mtimeMs === mtimeMs) {
    return cache.policy ? { policy: cache.policy } : { error: cache.error ?? "policy unavailable" };
  }

  try {
    const store = createSecurityPolicyStore({ env });
    const policy = store.getSnapshot().commands;
    cache = { directory: paths.directory, mtimeMs, policy };
    return { policy };
  } catch (error) {
    const failure = message(error);
    cache = { directory: paths.directory, mtimeMs, error: failure };
    return { error: failure };
  }
}

/** 测试用：清掉缓存，避免用例之间互相影响。 */
export function resetCommandPolicyCache(): void {
  cache = undefined;
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
