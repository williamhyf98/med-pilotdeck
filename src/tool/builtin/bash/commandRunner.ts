import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import type { MultiUserConfig } from "../../../pilot/config/parseMultiUserConfig.js";
import { resolvePilotHome } from "../../../pilot/paths.js";
import { selectSandbox, type CommandSandbox } from "./sandbox/index.js";

export type PilotDeckCommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 用户 home（沙箱可写根）。缺省时取 env 中的 PILOT_HOME。 */
  userHome?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called on each stdout chunk as it arrives. Errors thrown by the callback are swallowed. */
  onStdout?: (chunk: string) => void;
  /** Called on each stderr chunk as it arrives. Errors thrown by the callback are swallowed. */
  onStderr?: (chunk: string) => void;
};

export type PilotDeckCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type PilotDeckCommandRunner = {
  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult>;
};

type SpawnShell = typeof spawn;

/** 模块级沙箱实例：为 null 时 bash 直接交给 shell 执行（与引入沙箱前一致）。 */
let _sandbox: CommandSandbox | null = null;

export function getCommandSandbox(): CommandSandbox | null {
  return _sandbox;
}

export function setCommandSandbox(sandbox: CommandSandbox | null): void {
  _sandbox = sandbox;
}

/**
 * Gateway 启动时调用：按配置选择沙箱、执行 probe() 自检并设置模块级实例。
 * 显式配置的实现自检失败直接抛错；多用户模式下落到 none 的拒绝由 selectSandbox 负责。
 */
export async function initializeSandbox(config: MultiUserConfig, env: NodeJS.ProcessEnv): Promise<CommandSandbox> {
  const multiUserEnabled = isMultiUserLoginEnabled(env);
  const sandboxConfig = config.sandbox ?? {};
  const sandbox = await selectSandbox({
    configuredKind: sandboxConfig.kind,
    multiUserEnabled,
    allowUnsandboxed: sandboxConfig.allowUnsandboxed,
    platform: process.platform,
    network: sandboxConfig.network,
    extraReadOnlyBinds: sandboxConfig.extraReadOnlyBinds,
  });
  let probe: { ok: true } | { ok: false; reason: string };
  try {
    probe = await sandbox.probe();
  } catch (err) {
    probe = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!probe.ok && sandbox.kind !== "none") {
    throw new Error(`sandbox ${sandbox.kind} failed its startup probe: ${probe.reason}`);
  }
  if (sandbox.kind === "none" && multiUserEnabled) {
    console.warn("[sandbox] Multi-user mode running without an OS sandbox (multiUser.sandbox.allowUnsandboxed: true). This is UNSAFE for production.");
  }
  setCommandSandbox(sandbox);
  console.log(`[sandbox] ${sandbox.kind} (${probe.ok ? "ok" : probe.reason})`);
  return sandbox;
}

/** 与 ui/server/constants/config.js 的 DISABLE_LOCAL_AUTH 判定一致：仅显式设为 0 / false 时为多用户（登录）模式。 */
function isMultiUserLoginEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PILOTDECK_DISABLE_LOCAL_AUTH;
  return value === "0" || value === "false";
}

export class NodeShellCommandRunner implements PilotDeckCommandRunner {
  constructor(private readonly spawnShell: SpawnShell = spawn) {}

  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === "win32";
      // Windows 上的沙箱只会是 none，其 /bin/sh 不存在，保持原来的 shell（cmd.exe）执行方式。
      const sandbox = _sandbox && !(isWindows && _sandbox.kind === "none") ? _sandbox : null;
      // bwrap 的 --new-session 会调用 setsid()，而 detached 子进程在 spawn 时已是进程组组长，
      // setsid() 会以 EPERM 失败。因此 bwrap 不使用独立进程组，改为对 bwrap 进程本身发信号；
      // --unshare-pid + --die-with-parent 保证沙箱内的进程随之结束。
      const detached = !isWindows && sandbox?.kind !== "bwrap";
      const launch = sandbox
        ? sandbox.wrap(command, {
            cwd: options.cwd,
            userHome: options.userHome ?? resolvePilotHome(options.env ?? process.env),
            env: options.env ?? process.env,
          })
        : undefined;
      const child = launch
        ? this.spawnShell(launch.file, launch.args, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            detached,
            windowsHide: isWindows,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : this.spawnShell(command, {
            cwd: options.cwd,
            env: options.env,
            shell: true,
            detached,
            windowsHide: isWindows,
            stdio: ["ignore", "pipe", "pipe"],
          });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      function killProcessGroup() {
        const pid = child.pid;
        if (!pid) return;
        if (process.platform === "win32") {
          try {
            const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
              stdio: "ignore",
              windowsHide: true,
            });
            killer.on("error", () => undefined);
            killer.unref();
          } catch { /* best-effort */ }
        } else {
          // detached 时 pid 即进程组号，整组发信号；否则只能针对 pid 本身。
          const target = detached ? -pid : pid;
          try { process.kill(target, "SIGTERM"); } catch { /* already dead */ }
          setTimeout(() => {
            try { process.kill(target, "SIGKILL"); } catch { /* already dead */ }
          }, 3000).unref();
        }
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        killProcessGroup();
        forceResolveAfterKill();
      }, options.timeoutMs);

      const ABORT_FORCE_RESOLVE_MS = 15_000;

      function forceResolveAfterKill() {
        setTimeout(() => {
          if (settled) return;
          cleanup();
          resolve({
            exitCode: null,
            stdout,
            stderr: stderr + "\n[PilotDeck] Process did not exit within 15s after termination; force-resolved.",
            timedOut: true,
            durationMs: Date.now() - startedAt,
          });
        }, ABORT_FORCE_RESOLVE_MS).unref();
      }

      const onAbort = () => {
        if (settled) return;
        killProcessGroup();
        forceResolveAfterKill();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      function cleanup() {
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      }

      const stdoutDecoder = createShellOutputDecoder();
      const stderrDecoder = createShellOutputDecoder();
      let closeFallback: ReturnType<typeof setTimeout> | undefined;

      function finish(exitCode: number | null) {
        if (closeFallback) {
          clearTimeout(closeFallback);
          closeFallback = undefined;
        }
        stdout += stdoutDecoder.flush();
        stderr += stderrDecoder.flush();
        cleanup();
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = stdoutDecoder.decode(chunk);
        stdout += text;
        if (options.onStdout) {
          try {
            options.onStdout(text);
          } catch {
            // Progress callbacks are fire-and-forget; never crash the runner.
          }
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = stderrDecoder.decode(chunk);
        stderr += text;
        if (options.onStderr) {
          try {
            options.onStderr(text);
          } catch {
            // Progress callbacks are fire-and-forget; never crash the runner.
          }
        }
      });
      child.on("error", (error) => {
        stdout += stdoutDecoder.flush();
        stderr += stderrDecoder.flush();
        cleanup();
        if (options.signal?.aborted) {
          resolve({
            exitCode: null,
            stdout,
            stderr,
            timedOut: true,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        reject(error);
      });
      child.on("exit", (exitCode) => {
        if (process.platform !== "win32" || settled || closeFallback) {
          return;
        }
        closeFallback = setTimeout(() => {
          if (settled) return;
          finish(exitCode);
        }, 250);
        closeFallback.unref();
      });
      child.on("close", (exitCode) => {
        finish(exitCode);
      });
    });
  }
}

export type ShellOutputDecoder = {
  decode(chunk: Buffer): string;
  flush(): string;
};

export function createShellOutputDecoder(): ShellOutputDecoder {
  if (process.platform !== "win32") {
    const decoder = new TextDecoder("utf-8");
    return {
      decode: (chunk) => decoder.decode(chunk, { stream: true }),
      flush: () => decoder.decode(),
    };
  }

  return createWindowsShellOutputDecoder();
}

export function decodeShellOutput(chunk: Buffer): string {
  if (process.platform !== "win32") {
    return chunk.toString("utf8");
  }
  const decoder = createWindowsShellOutputDecoder();
  return decoder.decode(chunk) + decoder.flush();
}

function createWindowsShellOutputDecoder(): ShellOutputDecoder {
  let mode: "unknown" | "utf8" | "gb18030" = "unknown";
  let pending = Buffer.alloc(0);
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  let gb18030Decoder: TextDecoder | undefined;

  return {
    decode: (chunk) => {
      if (mode === "utf8") {
        return utf8Decoder.decode(chunk, { stream: true });
      }
      if (mode === "gb18030") {
        gb18030Decoder ??= new TextDecoder("gb18030");
        return gb18030Decoder.decode(chunk, { stream: true });
      }

      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      if (!hasNonAsciiByte(pending)) {
        const text = pending.toString("utf8");
        pending = Buffer.alloc(0);
        return text;
      }

      const utf8Status = inspectUtf8(pending);
      if (utf8Status === "incomplete") {
        return "";
      }
      if (utf8Status === "valid") {
        mode = "utf8";
        const text = utf8Decoder.decode(pending, { stream: true });
        pending = Buffer.alloc(0);
        return text;
      }

      mode = "gb18030";
      gb18030Decoder = new TextDecoder("gb18030");
      const text = gb18030Decoder.decode(pending, { stream: true });
      pending = Buffer.alloc(0);
      return text;
    },
    flush: () => {
      if (mode === "utf8") {
        return utf8Decoder.decode();
      }
      if (mode === "gb18030") {
        return gb18030Decoder?.decode() ?? "";
      }
      const text = pending.toString("utf8");
      pending = Buffer.alloc(0);
      return text;
    },
  };
}

function hasNonAsciiByte(chunk: Buffer): boolean {
  return chunk.some((byte) => byte >= 0x80);
}

function inspectUtf8(chunk: Buffer): "valid" | "incomplete" | "invalid" {
  for (let i = 0; i < chunk.length; i += 1) {
    const byte = chunk[i]!;
    if (byte <= 0x7f) continue;

    let expectedContinuation = 0;
    let minCodePoint = 0;
    let codePoint = 0;
    if (byte >= 0xc2 && byte <= 0xdf) {
      expectedContinuation = 1;
      minCodePoint = 0x80;
      codePoint = byte & 0x1f;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      expectedContinuation = 2;
      minCodePoint = 0x800;
      codePoint = byte & 0x0f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      expectedContinuation = 3;
      minCodePoint = 0x10000;
      codePoint = byte & 0x07;
    } else {
      return "invalid";
    }

    if (i + expectedContinuation >= chunk.length) {
      return "incomplete";
    }

    for (let offset = 1; offset <= expectedContinuation; offset += 1) {
      const continuation = chunk[i + offset]!;
      if ((continuation & 0xc0) !== 0x80) {
        return "invalid";
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    if (
      codePoint < minCodePoint ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return "invalid";
    }

    i += expectedContinuation;
  }
  return "valid";
}
