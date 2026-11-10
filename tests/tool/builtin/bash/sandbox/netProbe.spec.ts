import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoneSandbox } from "../../../../../src/tool/builtin/bash/sandbox/none.js";
import type { CommandSandbox } from "../../../../../src/tool/builtin/bash/sandbox/index.js";
import {
  networkIsolationLeaks,
  probeNetworkIsolation,
} from "../../../../../src/tool/builtin/bash/sandbox/netProbe.js";

function listen(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        close: () => server.close(),
      });
    });
  });
}

test("leak detection only reports reachable exits", () => {
  const clean = { sandboxKind: "bwrap", loopbackSelf: true, hostLoopback: false, external: false, dns: false };
  assert.deepEqual(networkIsolationLeaks(clean), []);
  assert.deepEqual(
    networkIsolationLeaks({ ...clean, hostLoopback: true, external: true, dns: true }),
    ["宿主回环端口可达", "外部地址可达", "DNS 可解析"],
  );
});

test("the probe really connects when nothing isolates it (NoneSandbox)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pd-probe-"));
  const target = await listen();
  try {
    const observation = await probeNetworkIsolation(new NoneSandbox(), {
      userHome: home,
      cwd: home,
      env: process.env,
      externalTargets: [{ host: "127.0.0.1", port: target.port }],
      dnsName: "localhost",
      timeoutMs: 20_000,
    });
    assert.equal(observation.sandboxKind, "none");
    // 沙箱内自起服务可用（N1 期望成功）
    assert.equal(observation.loopbackSelf, true, `probe error: ${observation.error ?? "none"}`);
    // 没有隔离时，外部目标必然可达 —— 这正是启动自检要拦下的情形
    assert.equal(observation.external, true);
    assert.ok(networkIsolationLeaks(observation).includes("外部地址可达"));
  } finally {
    target.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the probe reports an error instead of passing when it cannot run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pd-probe-"));
  const broken = {
    kind: "none",
    wrap: () => ({ file: "/bin/sh", args: ["-c", "echo probe-crashed >&2; exit 3"] }),
    probe: async () => ({ ok: true as const }),
    grants: () => ({ readOnly: [], writable: [] }),
  } as unknown as CommandSandbox;
  try {
    const observation = await probeNetworkIsolation(broken, {
      userHome: home,
      cwd: home,
      env: process.env,
      externalTargets: [],
      dnsName: "localhost",
      timeoutMs: 5_000,
    });
    // 命令拿不到结果时必须显式报错，不能被当成"已隔离"
    assert.ok(observation.error, "expected an error to be reported");
    assert.match(observation.error, /probe-crashed/u);
    assert.equal(observation.external, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
