import test from "node:test";
import assert from "node:assert/strict";
import { selectSandbox, type CommandSandbox, type SandboxFactories } from "../../../../../src/tool/builtin/bash/sandbox/index.js";
import { NoneSandbox } from "../../../../../src/tool/builtin/bash/sandbox/none.js";
import { BwrapSandbox } from "../../../../../src/tool/builtin/bash/sandbox/bwrap.js";
import { SandboxExecSandbox } from "../../../../../src/tool/builtin/bash/sandbox/sandboxExec.js";

type ProbeOutcome = { ok: true } | { ok: false; reason: string } | Error;
type Native = "bwrap" | "sandbox-exec";

class FakeSandbox implements CommandSandbox {
  probeCalls = 0;
  constructor(
    readonly kind: Native,
    private readonly outcome: ProbeOutcome,
  ) {}
  wrap(_command: string, _options: { cwd: string; userHome: string; env: NodeJS.ProcessEnv }): { file: string; args: string[] } {
    throw new Error("not used");
  }
  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.probeCalls += 1;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

/** 工厂计数：断言实际被实例化的是哪个实现。 */
function factories(bwrap: ProbeOutcome, sandboxExec: ProbeOutcome) {
  const made: Record<Native, FakeSandbox[]> = { bwrap: [], "sandbox-exec": [] };
  const f: SandboxFactories = {
    bwrap: () => {
      const s = new FakeSandbox("bwrap", bwrap);
      made.bwrap.push(s);
      return s;
    },
    "sandbox-exec": () => {
      const s = new FakeSandbox("sandbox-exec", sandboxExec);
      made["sandbox-exec"].push(s);
      return s;
    },
  };
  return { f, made };
}

test("configured kind wins and returns the matching implementation", async () => {
  const sandbox = await selectSandbox({ configuredKind: "none", multiUserEnabled: false, platform: "darwin" });
  assert.equal(sandbox.kind, "none");
  assert.ok(sandbox instanceof NoneSandbox);
});

test("configured bwrap or sandbox-exec is instantiated without auto-detection", async () => {
  const bwrap = await selectSandbox({ configuredKind: "bwrap", multiUserEnabled: false, platform: "darwin" });
  assert.ok(bwrap instanceof BwrapSandbox);
  const sbx = await selectSandbox({ configuredKind: "sandbox-exec", multiUserEnabled: false, platform: "linux" });
  assert.ok(sbx instanceof SandboxExecSandbox);
});

test("configured kind is not probed by selectSandbox (Gateway probes at startup)", async () => {
  const { f, made } = factories({ ok: false, reason: "missing" }, { ok: true });
  const sandbox = await selectSandbox({ configuredKind: "bwrap", multiUserEnabled: true, platform: "linux" }, f);
  assert.equal(sandbox.kind, "bwrap");
  assert.equal(made.bwrap.length, 1);
  assert.equal(made.bwrap[0].probeCalls, 0);
});

test("auto-detect on Linux picks bwrap when its probe succeeds", async () => {
  const { f, made } = factories({ ok: true }, { ok: true });
  const sandbox = await selectSandbox({ multiUserEnabled: false, platform: "linux" }, f);
  assert.equal(sandbox.kind, "bwrap");
  assert.equal(made["sandbox-exec"].length, 0);
});

test("auto-detect on Linux falls back to none when bwrap probe reports failure", async () => {
  const { f } = factories({ ok: false, reason: "bwrap not found" }, { ok: true });
  const sandbox = await selectSandbox({ multiUserEnabled: false, platform: "linux" }, f);
  assert.equal(sandbox.kind, "none");
});

test("auto-detect treats a throwing probe (skeleton) as unavailable and falls back to none", async () => {
  const { f } = factories(new Error("not implemented"), { ok: true });
  const sandbox = await selectSandbox({ multiUserEnabled: false, platform: "linux" }, f);
  assert.equal(sandbox.kind, "none");
});

test("auto-detect on macOS uses sandbox-exec and never tries bwrap", async () => {
  const { f, made } = factories({ ok: true }, { ok: true });
  const sandbox = await selectSandbox({ multiUserEnabled: false, platform: "darwin" }, f);
  assert.equal(sandbox.kind, "sandbox-exec");
  assert.equal(made.bwrap.length, 0);
});

test("auto-detect on macOS falls back to none when sandbox-exec probe fails", async () => {
  const { f } = factories({ ok: true }, { ok: false, reason: "sandbox-exec denied" });
  const sandbox = await selectSandbox({ multiUserEnabled: false, platform: "darwin" }, f);
  assert.equal(sandbox.kind, "none");
});

test("unsupported platforms resolve to none without probing anything", async () => {
  const { f, made } = factories({ ok: true }, { ok: true });
  const sandbox = await selectSandbox({ multiUserEnabled: false, platform: "win32" }, f);
  assert.equal(sandbox.kind, "none");
  assert.equal(made.bwrap.length + made["sandbox-exec"].length, 0);
});

test("default factories: auto-detect without multi-user returns a real sandbox kind", async () => {
  const sandbox = await selectSandbox({ multiUserEnabled: false, platform: "linux" });
  assert.ok(["bwrap", "none"].includes(sandbox.kind));
});

test("multi-user refuses to start when auto-detection falls back to none", async () => {
  const { f } = factories({ ok: false, reason: "bwrap not found" }, { ok: true });
  await assert.rejects(
    selectSandbox({ multiUserEnabled: true, platform: "linux" }, f),
    (err: Error) => /requires an OS sandbox/.test(err.message) && /bwrap unavailable: bwrap not found/.test(err.message),
  );
});

test("multi-user refuses explicitly configured none without allowUnsandboxed", async () => {
  await assert.rejects(
    selectSandbox({ configuredKind: "none", multiUserEnabled: true, platform: "linux" }),
    /requires an OS sandbox/,
  );
});

test("multi-user allows none when allowUnsandboxed is true", async () => {
  const sandbox = await selectSandbox({
    configuredKind: "none",
    multiUserEnabled: true,
    allowUnsandboxed: true,
    platform: "linux",
  });
  assert.equal(sandbox.kind, "none");
});

test("multi-user allows auto-detected fallback to none when allowUnsandboxed is true", async () => {
  const { f } = factories({ ok: false, reason: "bwrap not found" }, { ok: true });
  const sandbox = await selectSandbox({ multiUserEnabled: true, allowUnsandboxed: true, platform: "linux" }, f);
  assert.equal(sandbox.kind, "none");
});

test("multi-user does not refuse a successfully detected native sandbox", async () => {
  const { f } = factories({ ok: true }, { ok: true });
  const sandbox = await selectSandbox({ multiUserEnabled: true, platform: "linux" }, f);
  assert.equal(sandbox.kind, "bwrap");
});

test("single-user mode allows none without allowUnsandboxed", async () => {
  const sandbox = await selectSandbox({ configuredKind: "none", multiUserEnabled: false, platform: "linux" });
  assert.equal(sandbox.kind, "none");
});
