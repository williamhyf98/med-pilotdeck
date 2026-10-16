import { dirname } from "node:path";
import { BwrapSandbox, resolveAppRoot } from "./bwrap.js";
import { NoneSandbox } from "./none.js";
import { SandboxExecSandbox } from "./sandboxExec.js";

/**
 * bash 工具的操作系统级沙箱适配层（spec §16.3）。
 * `commandRunner.ts` 通过 `wrap()` 得到实际要 spawn 的 argv，cwd 与 stdio 语义不变。
 */
export interface CommandSandbox {
  readonly kind: "bwrap" | "sandbox-exec" | "none";
  /** 把原始命令包装成实际要 spawn 的 argv；不改变 cwd 与 stdio 语义 */
  wrap(command: string, options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] };
  /** 启动时自检：二进制存在、能执行 `true`，失败则返回原因 */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface SelectSandboxOptions {
  configuredKind?: "bwrap" | "sandbox-exec" | "none";
  multiUserEnabled: boolean;
  allowUnsandboxed?: boolean;
  platform: NodeJS.Platform;
  /** false = 网络隔离（仅 bwrap 使用）。默认 true。 */
  network?: boolean;
  /** 额外只读挂载的绝对路径（仅 bwrap 使用）。默认 []。 */
  extraReadOnlyBinds?: string[];
}

export type BwrapFactoryOptions = {
  network: boolean;
  extraReadOnlyBinds: string[];
};

/** 可替换的实现工厂，便于测试注入探测结果；生产代码使用默认工厂。 */
export interface SandboxFactories {
  bwrap(options: BwrapFactoryOptions): CommandSandbox;
  "sandbox-exec"(): CommandSandbox;
}

const DEFAULT_FACTORIES: SandboxFactories = {
  bwrap: (options) =>
    new BwrapSandbox({
      appRoot: resolveAppRoot(),
      nodeBinDir: dirname(process.execPath),
      network: options.network,
      extraBinds: options.extraReadOnlyBinds,
    }),
  "sandbox-exec": () =>
    new SandboxExecSandbox({
      appRoot: resolveAppRoot(),
      nodeBinDir: dirname(process.execPath),
    }),
};

type NativeKind = "bwrap" | "sandbox-exec";

function nativeKindFor(platform: NodeJS.Platform): NativeKind | undefined {
  if (platform === "linux") return "bwrap";
  if (platform === "darwin") return "sandbox-exec";
  return undefined;
}

function instantiate(
  kind: "bwrap" | "sandbox-exec" | "none",
  factories: SandboxFactories,
  bwrapOptions: BwrapFactoryOptions,
): CommandSandbox {
  switch (kind) {
    case "bwrap":
      return factories.bwrap(bwrapOptions);
    case "sandbox-exec":
      return factories["sandbox-exec"]();
    case "none":
      return new NoneSandbox();
  }
}

/** 返回 undefined 表示探测成功；抛错的骨架实现视为不可用。 */
async function probeFailureReason(sandbox: CommandSandbox): Promise<string | undefined> {
  try {
    const result = await sandbox.probe();
    return result.ok ? undefined : result.reason;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function resolveSandbox(
  options: SelectSandboxOptions,
  factories: SandboxFactories,
): Promise<{ sandbox: CommandSandbox; fallbackReason?: string }> {
  const bwrapOptions: BwrapFactoryOptions = {
    network: options.network ?? true,
    extraReadOnlyBinds: options.extraReadOnlyBinds ?? [],
  };
  if (options.configuredKind) {
    return { sandbox: instantiate(options.configuredKind, factories, bwrapOptions) };
  }
  const native = nativeKindFor(options.platform);
  if (!native) {
    return { sandbox: new NoneSandbox(), fallbackReason: `no OS sandbox available on ${options.platform}` };
  }
  const candidate = instantiate(native, factories, bwrapOptions);
  const failure = await probeFailureReason(candidate);
  if (failure === undefined) return { sandbox: candidate };
  return { sandbox: new NoneSandbox(), fallbackReason: `${native} unavailable: ${failure}` };
}

/**
 * 选择顺序：配置 `configuredKind` > 自动探测（Linux 试 bwrap，macOS 试 sandbox-exec）> none。
 * 多用户模式下落到 none 且未显式 `allowUnsandboxed: true` 时拒绝（fail-closed）。
 * 显式配置的实现不在这里 probe，由 Gateway 启动时调用 `probe()` 自检。
 */
export async function selectSandbox(
  options: SelectSandboxOptions,
  factories: SandboxFactories = DEFAULT_FACTORIES,
): Promise<CommandSandbox> {
  const { sandbox, fallbackReason } = await resolveSandbox(options, factories);
  if (sandbox.kind === "none" && options.multiUserEnabled && options.allowUnsandboxed !== true) {
    const detail = fallbackReason ? ` (${fallbackReason})` : "";
    throw new Error(
      `multi-user mode requires an OS sandbox, but none was selected${detail}. ` +
        "Install bubblewrap (Linux) or set multiUser.sandbox.allowUnsandboxed: true to run without one.",
    );
  }
  return sandbox;
}
