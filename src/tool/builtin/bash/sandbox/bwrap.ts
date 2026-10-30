import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandSandbox } from "./index.js";
import { appReadOnlyGrants, grantForms, skillCacheEnv, type SandboxGrants } from "./grants.js";

export type BwrapSandboxConfig = {
  /** 代码根目录（含 package.json），只读挂载。 */
  appRoot: string;
  /** Node 可执行文件所在目录，只读挂载。 */
  nodeBinDir: string;
  /** false = `--unshare-net`（网络隔离）。 */
  network: boolean;
  /** 额外只读挂载的绝对路径（系统程序，如 python3、libreoffice）。 */
  extraBinds: string[];
};

/** 系统只读挂载（spec §16.4）。 */
const SYSTEM_RO_BINDS = ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc/alternatives", "/etc/ssl", "/etc/resolv.conf"];

/** 从宿主透传的环境变量白名单；HOME / TMPDIR / PILOT_HOME 由 wrap() 固定设置。 */
const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "LANG",
  "PILOTDECK_OFFICE_RENDERER_URL",
  "PILOTDECK_OFFICE_RENDERER_TOKEN",
] as const;

const PROBE_TIMEOUT_MS = 10_000;

/** Linux bubblewrap 沙箱（spec §16.4）：只有用户 home 可写，其余系统与代码只读。 */
export class BwrapSandbox implements CommandSandbox {
  readonly kind = "bwrap";

  constructor(private readonly config: BwrapSandboxConfig) {}

  grants(userHome: string): SandboxGrants {
    const readOnly = [...SYSTEM_RO_BINDS, ...appReadOnlyGrants(this.config.appRoot, this.config.nodeBinDir),
      ...this.config.extraBinds.map((bind) => resolve(bind))].filter(existsSync);
    return {
      readOnly: [...new Set(readOnly.flatMap(grantForms))],
      writable: grantForms(userHome),
    };
  }

  wrap(command: string, options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] } {
    const { appRoot, nodeBinDir, network, extraBinds } = this.config;
    const cwd = resolve(options.cwd);
    const userHome = resolve(options.userHome);
    if (existsSync(userHome)) mkdirSync(join(userHome, ".tmp"), { recursive: true });
    const args: string[] = [
      // 清空宿主环境，下方只通过 --setenv 注入白名单，避免密钥随子进程泄漏
      "--clearenv",
      // 必须先挂 /tmp 的 tmpfs：bwrap 按参数顺序挂载，之后的 bind 才不会被它遮住
      // （userHome / appRoot 位于 /tmp 之下时仍然可见）。
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
    ];
    for (const path of SYSTEM_RO_BINDS.filter(existsSync)) {
      args.push("--ro-bind", path, path);
    }
    for (const path of appReadOnlyGrants(appRoot, nodeBinDir)) {
      args.push("--ro-bind", path, path);
    }
    args.push(
      // 用户 home 是唯一可写区域
      "--bind", userHome, userHome,
      // 隔离与生命周期
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--new-session",
      "--chdir", cwd,
    );
    if (!network) {
      args.push("--unshare-net");
    }
    for (const bind of extraBinds) {
      const path = resolve(bind);
      if (!existsSync(path)) continue;
      args.push("--ro-bind", path, path);
    }
    for (const key of PASSTHROUGH_ENV_KEYS) {
      const value = options.env[key];
      if (value) args.push("--setenv", key, value);
    }
    for (const [key, value] of Object.entries(skillCacheEnv(appRoot))) {
      args.push("--setenv", key, value);
    }
    args.push(
      "--setenv", "HOME", userHome,
      "--setenv", "TMPDIR", join(userHome, ".tmp"),
      "--setenv", "PILOT_HOME", userHome,
    );
    args.push("/bin/sh", "-c", command);
    return { file: "bwrap", args };
  }

  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const version = await runProbeProcess("bwrap", ["--version"]);
    if (version.spawnError) {
      return { ok: false, reason: `bwrap not found or cannot execute: ${version.spawnError.message}` };
    }
    if (version.code !== 0) {
      return { ok: false, reason: `bwrap binary found but --version failed (${describeExit(version)})` };
    }
    const trial = await runProbeProcess("bwrap", probeArgs());
    if (trial.spawnError) {
      return { ok: false, reason: `bwrap not found or cannot execute: ${trial.spawnError.message}` };
    }
    if (trial.code !== 0) {
      const stderr = trial.stderr.trim();
      return {
        ok: false,
        reason: `bwrap can run but fails to execute /bin/true in sandbox (${describeExit(trial)})${stderr ? `: ${stderr}` : ""}`,
      };
    }
    return { ok: true };
  }
}

/** 启动自检用的最小沙箱：与 wrap() 使用同样的生命周期参数，但不挂载 appRoot / userHome。 */
function probeArgs(): string[] {
  return [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/bin", "/bin",
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
    "--chdir", "/",
    "/bin/true",
  ];
}

type ProbeRun = {
  code: number | null;
  stderr: string;
  timedOut?: boolean;
  spawnError?: NodeJS.ErrnoException;
};

function describeExit(run: ProbeRun): string {
  return run.timedOut ? "timed out" : `exit ${run.code}`;
}

function runProbeProcess(file: string, args: string[]): Promise<ProbeRun> {
  return new Promise((resolvePromise) => {
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (run: ProbeRun) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ ...run, stderr });
    };
    const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"] });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stderr, timedOut: true });
    }, PROBE_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (spawnError: NodeJS.ErrnoException) => finish({ code: null, stderr, spawnError }));
    child.on("close", (code: number | null) => finish({ code, stderr }));
  });
}

/**
 * 从本模块位置向上查找含 package.json 的目录作为代码根（dist 与 src 布局均适用）。
 */
export function resolveAppRoot(startDir: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`cannot locate package.json above ${startDir}`);
    }
    dir = parent;
  }
}
