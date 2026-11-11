import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SandboxExecSandbox,
  buildSandboxProfile,
  runSandboxCheck,
} from "../../../../../src/tool/builtin/bash/sandbox/sandboxExec.js";
import { resolveAppRoot } from "../../../../../src/tool/builtin/bash/sandbox/bwrap.js";

const config = { appRoot: "/app", nodeBinDir: "/usr/bin" };

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("wrap() passes an inline profile that the user cannot replace", () => {
  withTempDir((tmpHome) => {
    const s = new SandboxExecSandbox(config);
    assert.equal(existsSync(join(tmpHome, ".tmp")), false, ".tmp is created lazily, not up front");
    const { file, args } = s.wrap("echo test", { cwd: tmpHome, userHome: tmpHome, env: {} });
    const profilePath = join(tmpHome, ".tmp", "sandbox.sb");
    assert.equal(s.kind, "sandbox-exec");
    assert.equal(file, "/usr/bin/sandbox-exec");
    assert.deepEqual(args, ["-p", buildSandboxProfile(config, tmpHome), "/bin/sh", "-c", "echo test"]);
    assert.ok(!existsSync(profilePath));
  });
});

test("profile content follows spec 16.5 and includes the user home, app root and node bin dir", () => {
  withTempDir((tmpHome) => {
    const profile = buildSandboxProfile(config, tmpHome);
    assert.ok(profile.includes("(version 1)"));
    assert.ok(profile.includes("(deny default)"));
    assert.ok(!profile.includes("(allow default)"), "the production profile must not allow everything");
    assert.ok(profile.includes("(allow process-exec process-fork signal)"));
    assert.ok(profile.includes("(allow sysctl-read mach-lookup)"));
    assert.ok(profile.includes("(allow network*)"));
    assert.ok(profile.includes('(allow file-read-metadata (literal "/Users")'));
    assert.ok(profile.includes(`(subpath "${tmpHome}")`));
    assert.ok(profile.includes('(subpath "/usr/bin")'));
    assert.ok(!profile.includes('(subpath "/app")'));
    assert.ok(!profile.includes('(subpath "/private/tmp")'));
  });
});

test("every literal metadata grant in the profile is reported to the startup guard", () => {
  const sandbox = new SandboxExecSandbox(config);
  const profile = buildSandboxProfile(config, "/data/users/2");
  const metadataLine = profile.split("\n").find((line) => line.startsWith("(allow file-read-metadata "));
  assert.ok(metadataLine);
  for (const literal of metadataLine.matchAll(/\(literal "([^"]+)"\)/g)) {
    assert.ok(sandbox.grants("/data/users/2").metadataOnly?.includes(literal[1]));
  }
});

test("profile grants writes only under userHome, system temp dirs and /dev/null", () => {
  withTempDir((tmpHome) => {
    const profile = buildSandboxProfile(config, tmpHome);
    const writeLine = profile.split("\n").find((line) => line.startsWith("(allow file* "));
    assert.ok(writeLine, "file* rule present");
    assert.ok(writeLine.includes('(literal "/dev/null")'));
    assert.ok(!writeLine.includes('(subpath "/app")'), "app root is not granted");
    assert.ok(!writeLine.includes('(subpath "/usr/bin")'), "node bin dir is read-only");
  });
});

test("a symlinked userHome is granted in both its raw and resolved forms", () => {
  withTempDir((dir) => {
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    const profile = buildSandboxProfile(config, link);
    assert.ok(profile.includes(`(subpath "${link}")`), "raw path");
    assert.ok(profile.includes(`(subpath "${realpathSync(real)}")`), "resolved path");
  });
});

test("SBPL special characters in paths are escaped", () => {
  withTempDir((tmpHome) => {
    mkdirSync(join(tmpHome, 'skills'));
    const profile = buildSandboxProfile({ appRoot: tmpHome, nodeBinDir: '/usr/bin' }, join(tmpHome, 'users', '1'));
    assert.ok(profile.includes(`(subpath "${join(tmpHome, 'skills')}")`));
    assert.ok(!profile.includes(`(subpath "${tmpHome}")`));
  });
});

test("runSandboxCheck reports success for a zero exit", () => {
  assert.deepEqual(runSandboxCheck("/bin/sh", ["-c", "exit 0"]), { ok: true });
});

test("runSandboxCheck reports the exit code and stderr for a failing command", () => {
  const result = runSandboxCheck("/bin/sh", ["-c", "echo boom >&2; exit 3"]);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /exit 3: boom/);
});

test("runSandboxCheck reports a missing binary as a spawn error", () => {
  const result = runSandboxCheck("/nonexistent/sandbox-exec-binary", []);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /ENOENT/);
});

test("probe succeeds on macOS and reports a reason elsewhere", async () => {
  const result = await new SandboxExecSandbox(config).probe();
  if (process.platform === "darwin") {
    assert.deepEqual(result, { ok: true });
  } else {
    assert.equal(result.ok, false);
    assert.ok((result as { reason: string }).reason.length > 0);
  }
});

test("on macOS a wrapped command runs inside userHome and cannot write outside it", {
  skip: process.platform !== "darwin" && "sandbox-exec is macOS-only",
}, () => {
  withTempDir((tmpHome) => {
    const sandbox = new SandboxExecSandbox({ appRoot: resolveAppRoot(), nodeBinDir: dirname(process.execPath) });
    const escapeTarget = join(homedir(), `sbx-escape-${process.pid}-${Date.now()}`);
    try {
      const launch = sandbox.wrap(
        `echo inside > ./ok.txt && cat ./ok.txt && echo blocked > "${escapeTarget}" 2>/dev/null; echo "escape-exit=$?"`,
        { cwd: tmpHome, userHome: tmpHome, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
      );
      const run = spawnSync(launch.file, launch.args, { cwd: tmpHome, encoding: "utf8" });
      assert.equal(run.status, 0, `sandboxed sh failed: ${run.stderr}`);
      assert.match(run.stdout, /inside/);
      assert.match(run.stdout, /escape-exit=[1-9]/);
      assert.equal(existsSync(escapeTarget), false, "write outside userHome must be denied");
      assert.equal(readFileSync(join(tmpHome, "ok.txt"), "utf8"), "inside\n");
    } finally {
      rmSync(escapeTarget, { force: true });
    }
  });
});

// ── 网络三态（spec §10.5，2026-11-11 macOS 实测） ─────────────────────────────

test("network: none 关闭全部网络，但保留回环的出入两条规则", () => {
  const profile = buildSandboxProfile({ ...config, network: "none" }, "/data/users/1");
  assert.ok(profile.includes("(deny network*)"));
  assert.ok(profile.includes('(allow network-outbound (remote ip "localhost:*"))'), "skill 自起服务要能自连");
  assert.ok(profile.includes('(allow network-inbound (local ip "localhost:*"))'), "只有出站时 listen 仍会 EPERM");
  assert.ok(!profile.includes("(allow network*)"));
  assert.ok(!profile.includes('"*:'), "none 档不得出现端口白名单");
});

test("network: allowlist 只放行端口：SBPL 的 remote ip 不接受数字 IP", () => {
  const profile = buildSandboxProfile(
    { ...config, network: "allowlist", networkAllow: [{ host: "10.31.112.13", port: 19400 }] },
    "/data/users/1",
  );
  assert.ok(profile.includes("(deny network*)"));
  assert.ok(profile.includes('(allow network-outbound (remote ip "*:19400"))'));
  assert.ok(!profile.includes("10.31.112.13"), "SBPL 写数字 IP 会直接报错，host 字段只能忽略");
  assert.ok(!profile.includes("(allow network*)"));
});

test("network: allowlist 的端口去重后排序，非法端口被丢弃", () => {
  const profile = buildSandboxProfile(
    {
      ...config,
      network: "allowlist",
      networkAllow: [
        { host: "a", port: 19400 },
        { host: "b", port: 19400 },
        { host: "c", port: 8080 },
        { host: "d", port: 0 },
      ],
    },
    "/data/users/1",
  );
  const rules = profile.split("\n").filter((line) => line.includes('remote ip "*:'));
  assert.deepEqual(rules, [
    '(allow network-outbound (remote ip "*:8080"))',
    '(allow network-outbound (remote ip "*:19400"))',
  ]);
});

test("wrap() 的单命令覆盖：false 走 none，true 且配了白名单走 allowlist", () => {
  withTempDir((tmpHome) => {
    const sandbox = new SandboxExecSandbox({
      ...config,
      network: "none",
      networkAllow: [{ host: "10.31.112.13", port: 19400 }],
    });
    const off = sandbox.wrap("echo a", { cwd: tmpHome, userHome: tmpHome, env: {}, network: false });
    const on = sandbox.wrap("echo b", { cwd: tmpHome, userHome: tmpHome, env: {}, network: true });
    const offProfile = off.args[1];
    const onProfile = on.args[1];
    assert.ok(offProfile.includes("(deny network*)"));
    assert.ok(!offProfile.includes('"*:19400"'));
    assert.ok(onProfile.includes('(allow network-outbound (remote ip "*:19400"))'), "放行的技能只开端口，不全开");
    assert.ok(!onProfile.includes("(allow network*)"));
  });
});

test("macOS 实测：none 档断外网与 DNS，回环按甲方案保留；allowlist 档端口放行", {
  skip: process.platform !== "darwin" && "sandbox-exec is macOS-only",
}, async () => {
  const net = await import("node:net");
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connectScript = (host: string, target: number) =>
    `require('node:net').connect({host:${JSON.stringify(host)},port:${target}}).on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',(e)=>{console.log('BLOCKED:'+e.code);process.exit(0)})`;
  const runIn = (networkConfig: { network: "none" | "allowlist" | "open"; networkAllow?: { host: string; port: number }[] }) => {
    const sandbox = new SandboxExecSandbox({ appRoot: resolveAppRoot(), nodeBinDir: dirname(process.execPath), ...networkConfig });
    return (script: string) => {
      const tmpHome = mkdtempSync(join(tmpdir(), "sb-net-"));
      try {
        const launch = sandbox.wrap(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, {
          cwd: tmpHome,
          userHome: tmpHome,
          env: {},
        });
        const run = spawnSync(launch.file, launch.args, { cwd: tmpHome, encoding: "utf8", timeout: 20000 });
        return run.stdout.trim();
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    };
  };
  try {
    const none = runIn({ network: "none" });
    assert.equal(none(connectScript("1.1.1.1", 443)), "BLOCKED:EPERM", "外网必须被断");
    assert.equal(none(connectScript("127.0.0.1", port)), "CONNECTED", "甲方案保留回环（换来 skill 自起自连可用）");
    assert.equal(
      none(`require('node:dns').lookup('example.com',(e)=>{console.log(e?'BLOCKED':'RESOLVED');process.exit(0)})`),
      "BLOCKED",
      "DNS 必须被断",
    );
    const allow = runIn({ network: "allowlist", networkAllow: [{ host: "127.0.0.1", port }] });
    assert.equal(allow(connectScript("127.0.0.1", port)), "CONNECTED");
    assert.equal(allow(connectScript("1.1.1.1", 443)), "BLOCKED:EPERM");
    assert.equal(runIn({ network: "open" })(connectScript("127.0.0.1", port)), "CONNECTED");
  } finally {
    server.close();
  }
});
