import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import type { MultiUserConfig } from "../../../pilot/config/parseMultiUserConfig.js";
import { resolvePilotHome } from "../../../pilot/paths.js";
import { selectSandbox, type CommandSandbox } from "./sandbox/index.js";
import { grantForms, skillCacheEnv } from "./sandbox/grants.js";
import { resolveAppRoot } from "./sandbox/bwrap.js";
import {
  assertNetworkPolicySupported,
  resolveCommandNetworkPolicy,
  type CommandNetworkDecision,
} from "./sandbox/networkPolicy.js";
import { networkIsolationLeaks, probeNetworkIsolation } from "./sandbox/netProbe.js";
import { describeWriteScope } from "./sandbox/writeScope.js";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import type { SandboxNetworkMode } from "../../../pilot/config/types.js";
import { appendAudit } from "../../../security/audit/auditLog.js";

export type PilotDeckCommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 用户 home（沙箱可写根）。缺省时取 env 中的 PILOT_HOME。 */
  userHome?: string;
  /**
   * 本次调用声明可写的目录（通常是 agent 工作区）。
   * 仅当 `multiUser.sandbox.narrowWrites: true` 时生效；缺省为 `[cwd]`。
   */
  writeRoots?: readonly string[];
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

/** 网络出口策略（spec §10.5）：全局默认值 + 允许 `open` 的技能白名单。 */
type NetworkPolicyState = {
  policy: SandboxNetworkMode;
  openSkills: readonly string[];
};
let _networkPolicy: NetworkPolicyState | null = null;

export function getCommandSandbox(): CommandSandbox | null {
  return _sandbox;
}

export function setCommandSandbox(sandbox: CommandSandbox | null): void {
  _sandbox = sandbox;
}

export function setNetworkPolicy(policy: NetworkPolicyState | null): void {
  _networkPolicy = policy;
}

export function getNetworkPolicy(): NetworkPolicyState | null {
  return _networkPolicy;
}

/** 按命令判定本次调用是否放行网络；没有策略时返回 null（保持旧行为）。 */
export function decideCommandNetwork(command: string): CommandNetworkDecision | null {
  if (!_networkPolicy) return null;
  return resolveCommandNetworkPolicy(command, _networkPolicy.policy, _networkPolicy.openSkills);
}

/**
 * Gateway 启动时调用：按配置选择沙箱、执行 probe() 自检并设置模块级实例。
 * 显式配置的实现自检失败直接抛错；多用户模式下落到 none 的拒绝由 selectSandbox 负责。
 */
export async function initializeSandbox(config: MultiUserConfig, env: NodeJS.ProcessEnv): Promise<CommandSandbox> {
  const multiUserEnabled = isMultiUserLoginEnabled(env);
  const sandboxConfig = config.sandbox ?? {};
  const networkPolicy = sandboxConfig.network ?? "open";
  const networkAllow = sandboxConfig.networkAllow ?? [];
  const narrowWrites = sandboxConfig.narrowWrites ?? false;
  assertNetworkPolicySupported(networkPolicy, process.platform, networkAllow);
  const sandbox = await selectSandbox({
    configuredKind: sandboxConfig.kind,
    multiUserEnabled,
    allowUnsandboxed: sandboxConfig.allowUnsandboxed,
    platform: process.platform,
    network: networkPolicy !== "none",
    extraReadOnlyBinds: sandboxConfig.extraReadOnlyBinds,
    networkMode: networkPolicy,
    networkAllow,
    narrowWrites,
  });
  if (multiUserEnabled && sandbox.kind !== "none") {
    if (!env.PILOT_HOME || !isAbsolute(env.PILOT_HOME)) {
      throw new Error("Multi-user sandbox requires an absolute PILOT_HOME.");
    }
    assertSandboxGrantsSafe(sandbox, env.PILOT_HOME, { narrowWrites });
  }
  let probe: { ok: true } | { ok: false; reason: string };
  try {
    probe = await sandbox.probe();
  } catch (err) {
    probe = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!probe.ok && sandbox.kind !== "none") {
    appendAudit({
      action: "sandbox.denied",
      decision: "error",
      tool: "sandbox",
      reason: "startup-probe-failed",
      meta: { kind: sandbox.kind },
    }, { env });
    throw new Error(`sandbox ${sandbox.kind} failed its startup probe: ${probe.reason}`);
  }
  if (sandbox.kind === "none" && multiUserEnabled) {
    console.warn("[sandbox] Multi-user mode running without an OS sandbox (multiUser.sandbox.allowUnsandboxed: true). This is UNSAFE for production.");
  }
  setCommandSandbox(sandbox);
  console.log(
    `[sandbox] ${sandbox.kind} (${probe.ok ? "ok" : probe.reason})` +
      `, writes=${describeWriteScope(narrowWrites)}`,
  );

  const openSkills = sandboxConfig.networkOpenSkills ?? [];
  setNetworkPolicy({ policy: networkPolicy, openSkills });
  const openNote = openSkills.length > 0 ? `, openSkills=${openSkills.join("|")}` : "";
  const allowNote =
    networkPolicy === "allowlist" || networkAllow.length > 0
      ? `, allowPorts=${[...new Set(networkAllow.map((entry) => entry.port))].join("|")}`
      : "";
  console.log(`[sandbox] network=${networkPolicy}${openNote}${allowNote}`);

  if (networkPolicy === "none") {
    await assertNetworkIsolationOnStartup(sandbox, env);
  }
  return sandbox;
}

/**
 * `network: none` 的启动自检（spec §10.5.4 / §10.5.5）。
 * 只要有一条出口真的通着，就拒绝启动 —— 避免"配了但没生效"的静默失效。
 */
async function assertNetworkIsolationOnStartup(
  sandbox: CommandSandbox,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const userHome = resolvePilotHome(env);
  try {
    mkdirSync(userHome, { recursive: true });
  } catch {
    // 目录建不出来时交给下面的自检去暴露问题
  }
  const observation = await probeNetworkIsolation(sandbox, {
    userHome,
    cwd: existsSync(userHome) ? userHome : process.cwd(),
    env,
    log: (message) => console.log(message),
  });
  // macOS 没有 network namespace，放行回环后宿主回环必然可达（甲方案，spec §10.5）。
  const leaks = networkIsolationLeaks(observation, {
    allowHostLoopback: process.platform === "darwin",
  });
  if (leaks.length > 0) {
    appendAudit({
      action: "sandbox.denied",
      decision: "error",
      tool: "sandbox",
      reason: "network-isolation-leaks",
      meta: { kind: sandbox.kind, leaks: String(leaks.length) },
    }, { env });
    throw new Error(
      `[sandbox] 网络隔离自检失败（sandbox=${sandbox.kind}）：${leaks.join("；")}。` +
        "multiUser.sandbox.network=none 要求完全断网，拒绝启动以免形成" +
        "「配了但没生效」的静默失效。详见 docs/permission-arch-v2-design.zh.md §10.5。",
    );
  }
  if (!observation.loopbackSelf) {
    console.warn(
      `[sandbox] 网络自检警告：沙箱内 127.0.0.1 不可用（${observation.error ?? "回环探测失败"}）。` +
        "依赖本机回环的 skill（如 frontend-slides 导出 PDF）可能失败。",
    );
  }
  console.log(`[sandbox] 网络自检通过（${observation.durationMs} ms）：内网/公网/DNS 均不可达`);
}

/**
 * 用户可以整体抛弃的目录（W6）。收窄档位下这些**任何一个**出现在 writable 里都是配置错误：
 * - `memory` / `logs`：agent 的记忆与日志，写坏等于篡改审计
 * - `skills`：技能脚本本体，写坏等于任意执行
 * - `.trash`：回收站（删除/恢复靠 rename），被 bash 直接 rm 等于绕过审计
 * - `projects`：项目元数据（`.cwd` marker），不是用户文件
 * - `workspaces`：工作区根；只允许当前工作区（由 `writeRoots` 声明）
 */
const NARROW_FORBIDDEN_HOME_DIRS = ["memory", "logs", "skills", ".trash", "projects", "workspaces"] as const;

export type SandboxGrantScopes = {
  /** 开关打开时才做 W6 反向断言；关闭时保持历史行为（整个 home 可写）。 */
  narrowWrites?: boolean;
  /** 本次允许可写的根（通常是 agent 工作区）。 */
  writeRoots?: readonly string[];
};

/**
 * Verify the actual OS grants, not the assumed layout of the application.
 *
 * `narrowWrites: true` 时额外断言（W6，fail-closed）：可写范围只能是
 * 「`writeRoots` + `.cache` + `.tmp`」，任何覆盖 `memory/logs/skills/.trash/projects`、
 * 覆盖 `workspaces` 根或兄弟工作区、落在 home 之外的可写授权都视为实现错误，启动即失败。
 */
export function assertSandboxGrantsSafe(
  sandbox: CommandSandbox,
  userHome: string,
  scopes: SandboxGrantScopes = {},
): void {
  const home = resolve(userHome);
  const users = dirname(home);
  const dataRoot = dirname(users);
  if (users === dataRoot || home === users || !existsSync(users) || dirname(home) !== users || users.split(/[\\/]/).at(-1) !== "users") {
    throw new Error("Invalid per-user PILOT_HOME for sandbox authorization.");
  }
  const protectedPaths = [dataRoot, users, join(dataRoot, "system"), join(dataRoot, "pilotdeck.yaml")];
  const otherHomes = readdirSync(users).filter((id) => id !== home.split(/[\\/]/).at(-1))
    .map((id) => join(users, id));
  const own = grantForms(home);
  const covered = (candidate: string, grant: string) => {
    const rel = relative(grant, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const grants = sandbox.grants(home);
  for (const grant of [...grants.readOnly, ...grants.writable]) {
    for (const form of grantForms(grant)) {
      for (const protectedPath of protectedPaths) {
        for (const target of grantForms(protectedPath)) {
          if (covered(target, form) && !own.some((root) => covered(form, root))) {
            throw new Error(`Unsafe sandbox grant ${form} covers protected location ${target}.`);
          }
        }
      }
      for (const other of otherHomes) {
        for (const target of grantForms(other)) {
          if (covered(target, form) || covered(form, target)) {
            throw new Error(`Unsafe sandbox grant ${form} overlaps another user home ${target}.`);
          }
        }
      }
    }
  }
  if (scopes.narrowWrites === true) assertNarrowWritableScope(grants.writable, home, scopes.writeRoots ?? [], covered);
  // macOS allows literal stat() on selected ancestors to traverse into shared
  // runtimes. These literals do not grant directory contents; reject any that
  // point inside protected data (except the current user's home).
  //
  // chdir() resolves every path component, so the user's own ancestor chain
  // (…/users, …/data-root, …) must be granted metadata too, otherwise `cd` in
  // the sandbox fails with ENOTDIR even though `ls` works. Ancestors of the
  // current home are therefore allowed, while sibling homes and anything
  // below `users/` stay rejected.
  for (const grant of grants.metadataOnly ?? []) {
    for (const form of grantForms(grant)) {
      if (own.some((root) => covered(form, root) || covered(root, form))) continue;
      if ([...protectedPaths, ...otherHomes].some((target) =>
        grantForms(target).some((protectedForm) => covered(form, protectedForm)))) {
        throw new Error(`Unsafe sandbox metadata grant ${form} overlaps protected data.`);
      }
    }
  }
}

/** W6：收窄档位下把"可写范围"逐条压回白名单，任何越界即抛错。 */
function assertNarrowWritableScope(
  writable: readonly string[],
  home: string,
  writeRoots: readonly string[],
  covered: (candidate: string, root: string) => boolean,
): void {
  // macOS 的 /var ↔ /private/var：授权与 home 可能以两种拼写出现，两边都要比。
  const homeForms = grantForms(home);
  const workspacesForms = grantForms(join(home, "workspaces"));
  const forbidden = NARROW_FORBIDDEN_HOME_DIRS.filter((name) => name !== "workspaces")
    .map((name) => ({ name, forms: grantForms(join(home, name)) }));
  const allowedForms = writeRoots.flatMap((root) => grantForms(root));
  for (const grant of writable) {
    for (const form of grantForms(grant)) {
      // 1) 可写授权必须落在 home 内：落到 /tmp 之类等于绕开全部隔离。
      if (!homeForms.some((root) => covered(form, root))) {
        throw new Error(`Unsafe narrow write grant ${form} escapes the user home.`);
      }
      // 2) home 本身永远不能再整体可写。
      if (homeForms.some((root) => covered(root, form))) {
        throw new Error(`Unsafe narrow write grant ${form} covers the whole user home.`);
      }
      // 3) `workspaces` 根不可写；其内部只允许 `writeRoots` 声明的当前工作区。
      if (workspacesForms.some((root) => covered(root, form))) {
        throw new Error(`Unsafe narrow write grant ${form} covers the workspaces root.`);
      }
      if (workspacesForms.some((root) => covered(form, root)) && !allowedForms.some((allowed) => covered(form, allowed))) {
        throw new Error(`Unsafe narrow write grant ${form} covers another user workspace.`);
      }
      // 4) 其余受保护目录，双向都拒绝（覆盖它，或位于它内部）。
      for (const { name, forms } of forbidden) {
        if (forms.some((dir) => covered(dir, form) || covered(form, dir))) {
          throw new Error(`Unsafe narrow write grant ${form} overlaps protected directory ${join(home, name)}.`);
        }
      }
    }
  }
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
      // 按命令判定本次调用是否放行网络（spec §10.5）：白名单只做加法，其余落回全局策略。
      const networkDecision = decideCommandNetwork(command);
      const launch = sandbox
        ? sandbox.wrap(command, {
            cwd: options.cwd,
            userHome: options.userHome ?? resolvePilotHome(options.env ?? process.env),
            env: options.env ?? process.env,
            writeRoots: options.writeRoots ?? [options.cwd],
            ...(networkDecision ? { network: networkDecision.allowNetwork } : {}),
          })
        : undefined;
      const spawnEnv = sandbox?.kind === "sandbox-exec"
        ? { ...options.env, HOME: options.userHome ?? resolvePilotHome(options.env ?? process.env),
            PILOT_HOME: options.userHome ?? resolvePilotHome(options.env ?? process.env),
            XDG_CACHE_HOME: join(options.userHome ?? resolvePilotHome(options.env ?? process.env), ".cache"),
            TMPDIR: join(options.userHome ?? resolvePilotHome(options.env ?? process.env), ".tmp"),
            ...skillCacheEnv(resolveAppRoot()) }
        : options.env;
      const child = launch
        ? this.spawnShell(launch.file, launch.args, {
            cwd: options.cwd,
            env: spawnEnv,
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
