import { dirname } from "node:path";
import { BwrapSandbox, resolveAppRoot } from "./bwrap.js";
import { NoneSandbox } from "./none.js";
import { SandboxExecSandbox } from "./sandboxExec.js";
import type { SandboxGrants } from "./grants.js";
import type { SandboxNetworkAllowEntry, SandboxNetworkMode } from "../../../../pilot/config/types.js";

/**
 * bash 工具的操作系统级沙箱适配层（spec §16.3）。
 * `commandRunner.ts` 通过 `wrap()` 得到实际要 spawn 的 argv，cwd 与 stdio 语义不变。
 */
export type SandboxWrapOptions = {
  cwd: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
  /**
   * 本次调用声明可写的目录（通常是 agent 的工作区）。
   * 只有 `narrowWrites: true` 时才生效；`false` 时仍以整个 userHome 为可写根。
   */
  writeRoots?: readonly string[];
  /**
   * 本次调用的网络出口覆盖：`false` = 断网，`true` = 放行。
   * 不传时使用沙箱创建时的配置。用于「按技能区分出口」（spec §10.5）。
   */
  network?: boolean;
};

export interface CommandSandbox {
  readonly kind: "bwrap" | "sandbox-exec" | "none";
  /** 把原始命令包装成实际要 spawn 的 argv；不改变 cwd 与 stdio 语义 */
  wrap(command: string, options: SandboxWrapOptions): { file: string; args: string[] };
  /** 启动时自检：二进制存在、能执行 `true`，失败则返回原因 */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Effective filesystem grants for this user's command (including canonical symlink targets). */
  grants(userHome: string, writeRoots?: readonly string[]): SandboxGrants;
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
  /** 全局网络档位（spec §10.5）。优先于 `network`。 */
  networkMode?: SandboxNetworkMode;
  /** `allowlist` 档的端口白名单（macOS 只按 port 生成规则）。 */
  networkAllow?: SandboxNetworkAllowEntry[];
  /**
   * 可写范围收窄开关（`multiUser.sandbox.narrowWrites`）。默认 `false` = 整个 home 可写。
   * 见 `docs/plans/sandbox-write-scope-narrowing.md`。
   */
  narrowWrites?: boolean;
}

export type BwrapFactoryOptions = {
  network: boolean;
  extraReadOnlyBinds: string[];
  narrowWrites: boolean;
};

export type SandboxExecFactoryOptions = {
  network: SandboxNetworkMode;
  networkAllow: SandboxNetworkAllowEntry[];
  narrowWrites: boolean;
};

/** 可替换的实现工厂，便于测试注入探测结果；生产代码使用默认工厂。 */
export interface SandboxFactories {
  bwrap(options: BwrapFactoryOptions): CommandSandbox;
  "sandbox-exec"(options: SandboxExecFactoryOptions): CommandSandbox;
}

const DEFAULT_FACTORIES: SandboxFactories = {
  bwrap: (options) =>
    new BwrapSandbox({
      appRoot: resolveAppRoot(),
      nodeBinDir: dirname(process.execPath),
      network: options.network,
      extraBinds: options.extraReadOnlyBinds,
      narrowWrites: options.narrowWrites,
    }),
  "sandbox-exec": (options) =>
    new SandboxExecSandbox({
      appRoot: resolveAppRoot(),
      nodeBinDir: dirname(process.execPath),
      network: options.network,
      networkAllow: options.networkAllow,
      narrowWrites: options.narrowWrites,
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
  execOptions: SandboxExecFactoryOptions,
): CommandSandbox {
  switch (kind) {
    case "bwrap":
      return factories.bwrap(bwrapOptions);
    case "sandbox-exec":
      return factories["sandbox-exec"](execOptions);
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
    narrowWrites: options.narrowWrites ?? false,
  };
  const execOptions: SandboxExecFactoryOptions = {
    network: options.networkMode ?? (options.network === false ? "none" : "open"),
    networkAllow: options.networkAllow ?? [],
    narrowWrites: options.narrowWrites ?? false,
  };
  if (options.configuredKind) {
    return { sandbox: instantiate(options.configuredKind, factories, bwrapOptions, execOptions) };
  }
  const native = nativeKindFor(options.platform);
  if (!native) {
    return { sandbox: new NoneSandbox(), fallbackReason: `no OS sandbox available on ${options.platform}` };
  }
  const candidate = instantiate(native, factories, bwrapOptions, execOptions);
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
