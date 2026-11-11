import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CommandSandbox, SandboxWrapOptions } from "./index.js";
import { appReadOnlyGrants, grantForms, type SandboxGrants } from "./grants.js";
import type { SandboxNetworkAllowEntry, SandboxNetworkMode } from "../../../../pilot/config/types.js";

export type SandboxExecConfig = {
  /** 代码根目录，只读。 */
  appRoot: string;
  /** Node 可执行文件所在目录，只读。 */
  nodeBinDir: string;
  /** 网络出口档位（spec §10.5）。默认 `open`，即历史行为。 */
  network?: SandboxNetworkMode;
  /**
   * `allowlist` 档允许的端口。
   *
   * 注意：SBPL 的 `remote ip` 只接受 `*` 或 `localhost`（2026-11-11 实测），
   * 所以这里**只取 port**，host 字段在 macOS 上不生效。
   */
  networkAllow?: SandboxNetworkAllowEntry[];
};

export const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";
const PROBE_TRUE_BIN = "/usr/bin/true";
const PROBE_TIMEOUT_MS = 10_000;

/**
 * 系统只读目录（spec §16.5）。`/private/var/select` 是 /bin/sh 启动时读取的路径，缺失则 sh 直接 abort（实测）。
 */
const SYSTEM_READ_DIRS = ["/usr", "/bin", "/sbin", "/System", "/Library", "/private/etc", "/private/var/select", "/opt/homebrew"];
// Shared host temp is not writable: it may itself contain the deployment data root.
const SYSTEM_WRITE_DIRS: string[] = [];

/** SBPL 字符串转义：仅处理反斜杠与双引号。 */
function escapeSbpl(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 路径的原始形式与解析后的真实路径（去重）。sandbox-exec 按原始路径匹配，二者都需要。 */
const pathForms = grantForms;

function subpaths(paths: string[]): string {
  return [...new Set(paths)].map((p) => `(subpath "${escapeSbpl(p)}")`).join(" ");
}

/**
 * 回环规则（spec §10.5.3「甲方案」）。
 *
 * macOS 的 `(deny network*)` 连 127.0.0.1 一起断（Linux 的 `--unshare-net` 不会），
 * 而 skill 里存在「沙箱内自起服务再自连」的用法，因此必须同时放行出站与入站：
 * 只给出站时 `listen` 仍然 EPERM（2026-11-11 实测）。
 */
const LOOPBACK_RULES = [
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
];

/** 生成 profile 里的网络段（spec §10.5.8）。 */
export function buildNetworkRules(mode: SandboxNetworkMode, allow: readonly SandboxNetworkAllowEntry[] = []): string[] {
  if (mode === "open") return ["(allow network*)"];
  const rules = ["(deny network*)", ...LOOPBACK_RULES];
  if (mode === "allowlist") {
    const ports = [...new Set(allow.map((entry) => entry.port))]
      .filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
      .sort((a, b) => a - b);
    for (const port of ports) rules.push(`(allow network-outbound (remote ip "*:${port}"))`);
  }
  return rules;
}

/** Framework Python calls realpath on each ancestor of a shared venv. */
// 目录的**祖先链**必须可 stat，否则 `chdir` 直接失败：
// macOS 在 chdir 时要逐级解析路径，任何一层没拿到 file-read-metadata 就返回 ENOTDIR。
// 少了 userHome 那一串，沙箱里 `cd inbox/x` 会报 "Not a directory"，
// 而 `ls inbox/x` 却正常（open 只走叶子节点的 file* 授权）—— 这个组合会让人
// 以为是脚本写错了，实际是"相对路径全部按错目录解析"，产出静默全 0。
function metadataAncestors(config: SandboxExecConfig, userHome: string): string[] {
  const prefixes = ["/Users", ...appReadOnlyGrants(config.appRoot, config.nodeBinDir), userHome];
  const result = new Set<string>();
  for (const grant of prefixes) {
    for (const spelling of pathForms(grant)) {
      let dir = resolve(spelling);
      while (dir !== "/") {
        result.add(dir);
        dir = dirname(dir);
      }
    }
  }
  return [...result];
}

/** 生成 SBPL profile（spec §16.5）。 */
export function buildSandboxProfile(config: SandboxExecConfig, userHome: string): string {
  const readDirs = [...SYSTEM_READ_DIRS, ...appReadOnlyGrants(config.appRoot, config.nodeBinDir)].flatMap(pathForms);
  const writeDirs = [...pathForms(userHome), ...SYSTEM_WRITE_DIRS];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork signal)",
    "(allow sysctl-read mach-lookup)",
    ...buildNetworkRules(config.network ?? "open", config.networkAllow),
    // Read metadata only for each ancestor. Subpath /Users would also reveal
    // the names of every user account through stat() calls.
    `(allow file-read-metadata ${[...new Set(metadataAncestors(config, userHome))].map((p) => `(literal "${escapeSbpl(p)}")`).join(" ")})`,
    `(allow file-read* (literal "/") ${subpaths(readDirs)})`,
    `(allow file* (literal "/dev/null") ${subpaths(writeDirs)})`,
    "",
  ].join("\n");
}

/** 执行一次自检命令；成功返回 ok，失败给出可读原因（含 spawn 错误、超时、退出码与 stderr）。 */
export function runSandboxCheck(file: string, args: string[]): { ok: true } | { ok: false; reason: string } {
  const run = spawnSync(file, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  if (run.error) return { ok: false, reason: run.error.message };
  if (run.status !== 0) {
    const how = run.signal ? `signal ${run.signal}` : `exit ${run.status}`;
    const stderr = run.stderr.trim();
    return { ok: false, reason: `${how}${stderr ? `: ${stderr}` : ""}` };
  }
  return { ok: true };
}

/** macOS sandbox-exec 沙箱（仅开发自测，spec §16.5，不作为生产验收依据）。 */
export class SandboxExecSandbox implements CommandSandbox {
  readonly kind = "sandbox-exec";

  constructor(private readonly config: SandboxExecConfig) {}

  grants(userHome: string): SandboxGrants {
    return {
      readOnly: [...new Set([...SYSTEM_READ_DIRS, ...appReadOnlyGrants(this.config.appRoot, this.config.nodeBinDir)].flatMap(pathForms))],
      writable: [...new Set([...SYSTEM_WRITE_DIRS, userHome].flatMap(pathForms))],
      metadataOnly: metadataAncestors(this.config, userHome),
    };
  }

  wrap(command: string, options: SandboxWrapOptions): { file: string; args: string[] } {
    mkdirSync(join(options.userHome, ".tmp"), { recursive: true });
    // 单条命令的网络覆盖（spec §10.5）：false=断网；true=允许出网。
    // 全局配了 networkAllow 时，放行的技能走端口级 allowlist，而不是全开。
    const mode: SandboxNetworkMode =
      options.network === undefined
        ? (this.config.network ?? "open")
        : options.network === false
          ? "none"
          : (this.config.networkAllow?.length ?? 0) > 0
            ? "allowlist"
            : "open";
    // Inline the profile: a command with write access to userHome must never be
    // able to replace the policy file between wrap() and sandbox-exec startup.
    return {
      file: SANDBOX_EXEC_BIN,
      args: ["-p", buildSandboxProfile({ ...this.config, network: mode }, options.userHome), "/bin/sh", "-c", command],
    };
  }

  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      accessSync(SANDBOX_EXEC_BIN, fsConstants.X_OK);
    } catch (err) {
      return { ok: false, reason: `sandbox-exec not found or not executable at ${SANDBOX_EXEC_BIN}: ${errorMessage(err)}` };
    }
    // 1) 最小 profile 执行 /usr/bin/true：确认二进制本身可用。
    const minimal = runSandboxCheck(SANDBOX_EXEC_BIN, ["-p", "(version 1) (allow default)", PROBE_TRUE_BIN]);
    if (!minimal.ok) {
      return { ok: false, reason: `sandbox-exec exists but fails to run: ${minimal.reason}` };
    }
    // 2) 与 wrap() 同形的生产 profile 启动 /bin/sh：捕获 profile 写错导致每条命令都 abort 的情况。
    let workDir: string | undefined;
    try {
      workDir = mkdtempSync(join(tmpdir(), "sandbox-exec-probe-"));
      const profilePath = join(workDir, "probe.sb");
      writeFileSync(profilePath, buildSandboxProfile(this.config, workDir), "utf8");
      const shaped = runSandboxCheck(SANDBOX_EXEC_BIN, ["-f", profilePath, "/bin/sh", "-c", "exit 0"]);
      if (!shaped.ok) {
        return { ok: false, reason: `sandbox-exec profile cannot start /bin/sh: ${shaped.reason}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `sandbox-exec probe failed: ${errorMessage(err)}` };
    } finally {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
