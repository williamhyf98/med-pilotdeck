import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandSandbox } from "./index.js";

export type SandboxExecConfig = {
  /** 代码根目录，只读。 */
  appRoot: string;
  /** Node 可执行文件所在目录，只读。 */
  nodeBinDir: string;
};

export const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";
const PROBE_TRUE_BIN = "/usr/bin/true";
const PROBE_TIMEOUT_MS = 10_000;

/**
 * 系统只读目录（spec §16.5）。`/private/var/select` 是 /bin/sh 启动时读取的路径，缺失则 sh 直接 abort（实测）。
 */
const SYSTEM_READ_DIRS = ["/usr", "/bin", "/sbin", "/System", "/Library", "/private/etc", "/private/var/select", "/opt/homebrew"];
/**
 * 系统可写目录（spec §16.5）。`/tmp`、`/var/folders` 是 `/private/...` 的符号链接入口：
 * sandbox-exec 按进程访问时的原始路径匹配，不解析符号链接（实测）。
 */
const SYSTEM_WRITE_DIRS = ["/private/tmp", "/private/var/folders", "/tmp", "/var/folders"];

/** SBPL 字符串转义：仅处理反斜杠与双引号。 */
function escapeSbpl(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 路径的原始形式与解析后的真实路径（去重）。sandbox-exec 按原始路径匹配，二者都需要。 */
function pathForms(path: string): string[] {
  const forms = [path];
  try {
    const real = realpathSync(path);
    if (real !== path) forms.push(real);
  } catch {
    // 路径暂不存在时只使用原始形式
  }
  return forms;
}

function subpaths(paths: string[]): string {
  return [...new Set(paths)].map((p) => `(subpath "${escapeSbpl(p)}")`).join(" ");
}

/** 生成 SBPL profile（spec §16.5）。 */
export function buildSandboxProfile(config: SandboxExecConfig, userHome: string): string {
  const readDirs = [...SYSTEM_READ_DIRS, ...pathForms(config.appRoot), ...pathForms(config.nodeBinDir)];
  const writeDirs = [...pathForms(userHome), ...SYSTEM_WRITE_DIRS];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork signal)",
    "(allow sysctl-read mach-lookup)",
    "(allow network*)",
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

  wrap(command: string, options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] } {
    const profilePath = join(options.userHome, ".tmp", "sandbox.sb");
    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, buildSandboxProfile(this.config, options.userHome), "utf8");
    return { file: SANDBOX_EXEC_BIN, args: ["-f", profilePath, "/bin/sh", "-c", command] };
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
