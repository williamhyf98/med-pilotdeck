import { spawn } from "node:child_process";
import net from "node:net";
import type { CommandSandbox } from "./index.js";

/**
 * 启动时的网络隔离自检（spec §10.5.5 / 10.5.7）。
 *
 * 设计要点：**不看配置，只看事实**。在沙箱里真起服务、真去连，
 * 这样「配了但没生效」（macOS `network: false` 的现状）会直接把服务挡在启动阶段。
 */

export type NetworkProbeObservation = {
  sandboxKind: string;
  /** 沙箱内自起监听再自连：期望 true（保证 skill 内自起服务可用） */
  loopbackSelf: boolean;
  /** 连 Gateway 进程在宿主上开的监听：期望 false（宿主回环应被隔离） */
  hostLoopback: boolean;
  /** 连外部地址：期望 false */
  external: boolean;
  /** DNS 解析：期望 false */
  dns: boolean;
};

export type NetworkProbeResult = NetworkProbeObservation & {
  error?: string;
  durationMs: number;
};

export type NetworkProbeOptions = {
  userHome: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 外部探测目标，默认 `1.1.1.1:443`；测试可换成宿主端口以便确定性验证。 */
  externalTargets?: { host: string; port: number }[];
  dnsName?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
};

const PROBE_MARKER = "PROBE_JSON:";
const DEFAULT_TIMEOUT_MS = 20_000;

function listenOnHostLoopback(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

/**
 * 探针脚本（在沙箱内执行）。用 base64 传进来，避免任何 shell 引号问题。
 * 只输出一行 `PROBE_JSON:{...}`。
 */
function buildProbeSource(input: {
  hostPort: number;
  externalTargets: { host: string; port: number }[];
  dnsName: string;
}): string {
  const external = JSON.stringify(input.externalTargets);
  return `
const net = require('node:net');
const dns = require('node:dns');
function connect(host, port, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (settled) return; settled = true; try { socket.destroy(); } catch (e) {} resolve(value); };
    const socket = net.connect({ host, port });
    socket.setTimeout(ms, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
(async () => {
  const result = { loopbackSelf: false, hostLoopback: false, external: false, dns: false };
  result.loopbackSelf = await new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const ok = port > 0 ? await connect('127.0.0.1', port, 1500) : false;
      server.close();
      resolve(ok);
    });
  });
  result.hostLoopback = await connect('127.0.0.1', ${input.hostPort}, 1500);
  for (const target of ${external}) {
    if (await connect(target.host, target.port, 2500)) { result.external = true; break; }
  }
  result.dns = await new Promise((resolve) => dns.lookup(${JSON.stringify(input.dnsName)}, (err) => resolve(!err)));
  console.log('${PROBE_MARKER}' + JSON.stringify(result));
})();
`.trim();
}

export async function probeNetworkIsolation(
  sandbox: CommandSandbox,
  options: NetworkProbeOptions,
): Promise<NetworkProbeResult> {
  const startedAt = Date.now();
  const log = options.log ?? (() => {});
  const host = await listenOnHostLoopback();
  const source = buildProbeSource({
    hostPort: host.port,
    externalTargets: options.externalTargets ?? [{ host: "1.1.1.1", port: 443 }],
    dnsName: options.dnsName ?? "example.com",
  });
  const payload = Buffer.from(source, "utf8").toString("base64");
  const command = `"${process.execPath}" -e "eval(Buffer.from('${payload}','base64').toString('utf8'))"`;
  const launch = sandbox.wrap(command, {
    cwd: options.cwd,
    userHome: options.userHome,
    env: options.env,
    // 自检必须按"断网"执行，才能验证 none 档是否真的断
    network: false,
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const output = await new Promise<{ stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn(launch.file, launch.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: `${stderr}${error.message}`, timedOut });
      });
      child.once("close", () => {
        clearTimeout(timer);
        resolve({ stdout, stderr, timedOut });
      });
    });

    const line = output.stdout
      .split("\n")
      .reverse()
      .find((candidate) => candidate.startsWith(PROBE_MARKER));
    if (!line) {
      const detail = (output.stderr || output.stdout).trim().split("\n").slice(-3).join(" | ");
      log(`[sandbox] 网络自检未拿到结果（${sandbox.kind}）：${detail || "无输出"}`);
      return {
        sandboxKind: sandbox.kind,
        loopbackSelf: false,
        hostLoopback: false,
        external: false,
        dns: false,
        error: output.timedOut ? `probe timed out after ${timeoutMs} ms` : `probe produced no result${detail ? `: ${detail}` : ""}`,
        durationMs: Date.now() - startedAt,
      };
    }
    const parsed = JSON.parse(line.slice(PROBE_MARKER.length)) as Partial<NetworkProbeObservation>;
    return {
      sandboxKind: sandbox.kind,
      loopbackSelf: parsed.loopbackSelf === true,
      hostLoopback: parsed.hostLoopback === true,
      external: parsed.external === true,
      dns: parsed.dns === true,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    host.close();
  }
}

/**
 * 把观测结果转成"哪些出口漏了"。空数组 = 隔离生效。
 *
 * `allowHostLoopback`：macOS 的 sandbox-exec 没有 network namespace，无法把沙箱回环
 * 与宿主回环分开（Linux 的 `--unshare-net` 可以）。甲方案选择放行回环以保证
 * 「skill 自起服务再自连」可用，代价就是宿主回环不再隔离，因此这一条在 macOS 上
 * 不计为泄漏（spec §10.5，2026-11-11 实测）。
 */
export function networkIsolationLeaks(
  observation: NetworkProbeObservation,
  options: { allowHostLoopback?: boolean } = {},
): string[] {
  const leaks: string[] = [];
  if (observation.hostLoopback && options.allowHostLoopback !== true) leaks.push("宿主回环端口可达");
  if (observation.external) leaks.push("外部地址可达");
  if (observation.dns) leaks.push("DNS 可解析");
  return leaks;
}
