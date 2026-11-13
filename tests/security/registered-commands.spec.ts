// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRegisteredInvocation,
  evaluateRegisteredCommand,
} from "../../src/security/policy/registeredCommands.js";
import { parseCommandPolicy } from "../../src/security/policy/parseCommandPolicy.js";
import { resetCommandPolicyCache } from "../../src/security/policy/commandPolicyRuntime.js";
import { classifyBashPermission } from "../../src/tool/builtin/bash/permissions.js";

const DEFAULT_POLICY = parseCommandPolicy(undefined);
const DATA_SCRIPT = join("/srv/app", "skills", "data-analysis", "scripts", "analysis.sh");

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-registered-"));
  const pilotHome = join(root, "users", "1");
  const workspace = join(pilotHome, "workspaces", "general", "ws1");
  try {
    await mkdir(join(workspace, "inbox", "batch1"), { recursive: true });
    await mkdir(join(workspace, "exports"), { recursive: true });
    await mkdir(join(workspace, "scratch", "work"), { recursive: true });
    await fn({ root, pilotHome, workspace, env: { PILOT_HOME: pilotHome } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const goodCommand = (out) =>
  `bash ${DATA_SCRIPT} run --script scratch/work/t1/analysis.py --input inbox/batch1 --out ${out}`;

test("detectRegisteredInvocation recognises <skills>/<skill>/scripts/*.sh <sub>", () => {
  assert.deepEqual(detectRegisteredInvocation(["bash", DATA_SCRIPT, "run", "--out", "exports/x"]), {
    id: "data-analysis.run", skill: "data-analysis", subcommand: "run",
    args: ["--out", "exports/x"],
  });
  assert.equal(detectRegisteredInvocation([DATA_SCRIPT, "check"])?.id, "data-analysis.check");
  assert.equal(detectRegisteredInvocation(["python3", "skills/data-analysis/scripts/analysis.py"]), undefined);
  assert.equal(detectRegisteredInvocation(["bash", "scripts/analysis.sh", "run"]), undefined);
  assert.equal(detectRegisteredInvocation(["bash", DATA_SCRIPT]), undefined);
  assert.equal(detectRegisteredInvocation([]), undefined);
});

test("compliant registered invocation is allowed", async () => {
  await withWorkspace(async ({ workspace }) => {
    const tokens = ["bash", DATA_SCRIPT, "run", "--script", "scratch/work/t1/analysis.py", "--input", "inbox/batch1", "--out", "exports/analysis/a-1"];
    const result = evaluateRegisteredCommand(tokens, { policy: DEFAULT_POLICY, cwd: workspace });
    assert.equal(result.kind, "allow");
    assert.equal(result.rule.id, "data-analysis.run");
  });
});

// 链式分析：上一次 run 的产物直接作为下一次 `--input`，不必先 cp 回 scratch。
test("--input may point at a previous run under exports/", async () => {
  await withWorkspace(async ({ workspace }) => {
    const tokens = [
      "bash", DATA_SCRIPT, "run",
      "--script", "scratch/work/t2/analysis.py",
      "--input", "exports/analysis/xiaohua-dedup/20261112-062930/tables",
      "--out", "exports/analysis/xiaohua-cat",
    ];
    const result = evaluateRegisteredCommand(tokens, { policy: DEFAULT_POLICY, cwd: workspace });
    assert.equal(result.kind, "allow");
    assert.equal(result.rule.id, "data-analysis.run");
  });
});

test("writing outside the registered output roots is a security violation", async () => {
  await withWorkspace(async ({ workspace }) => {
    const tokens = ["bash", DATA_SCRIPT, "run", "--out", "inbox/x"];
    const result = evaluateRegisteredCommand(tokens, { policy: DEFAULT_POLICY, cwd: workspace });
    assert.equal(result.kind, "violation");
    assert.equal(result.security, true);
    assert.match(result.reason, /allowed roots/);
  });
});

test("path escape and absolute paths outside the roots are rejected", async () => {
  await withWorkspace(async ({ workspace }) => {
    for (const value of ["../../etc/passwd", "/etc/passwd", "exports/../inbox/x"]) {
      const result = evaluateRegisteredCommand(
        ["bash", DATA_SCRIPT, "run", "--out", value],
        { policy: DEFAULT_POLICY, cwd: workspace },
      );
      assert.equal(result.kind, "violation", `expected violation for ${value}`);
      assert.equal(result.security, true);
    }
  });
});

test("unregistered option / positional arg / --flag=value are not auto-allowed", async () => {
  await withWorkspace(async ({ workspace }) => {
    const cases = [
      ["--nope", "1"],
      ["stray-positional"],
      ["--out=exports/x"],
    ];
    for (const extra of cases) {
      const result = evaluateRegisteredCommand(
        ["bash", DATA_SCRIPT, "run", ...extra],
        { policy: DEFAULT_POLICY, cwd: workspace },
      );
      assert.notEqual(result.kind, "allow", `expected refuse for ${extra.join(" ")}`);
    }
  });
});

test("commands outside the registry are unregistered", async () => {
  await withWorkspace(async ({ workspace }) => {
    const result = evaluateRegisteredCommand(
      ["bash", join("/srv/app", "skills", "unknown", "scripts", "x.sh"), "run"],
      { policy: DEFAULT_POLICY, cwd: workspace },
    );
    assert.equal(result.kind, "unregistered");
  });
});

test("classifyBashPermission allows the compliant data-analysis command with no prompt", async () => {
  await withWorkspace(async ({ workspace, env }) => {
    resetCommandPolicyCache();
    const result = classifyBashPermission(goodCommand("exports/analysis/a-1"), { cwd: workspace, env });
    assert.equal(result.type, "allow");
    assert.match(result.reason.message, /data-analysis\.run/);
  });
});

test("classifyBashPermission denies a registered command that writes into inbox", async () => {
  await withWorkspace(async ({ workspace, env }) => {
    resetCommandPolicyCache();
    const result = classifyBashPermission(goodCommand("inbox/x"), { cwd: workspace, env });
    assert.equal(result.type, "deny");
    assert.match(result.message, /allowed roots/);
  });
});

test("classifyBashPermission still asks for ad-hoc python, and denies curl", async () => {
  await withWorkspace(async ({ workspace, env }) => {
    resetCommandPolicyCache();
    assert.equal(classifyBashPermission("python3 /tmp/x.py", { cwd: workspace, env }).type, "ask");
    assert.equal(classifyBashPermission("curl http://10.31.112.13:19400", { cwd: workspace, env }).type, "deny");
  });
});

test("a broken command-policy.yaml fails closed (falls back to ask) and is audited", async () => {
  await withWorkspace(async ({ pilotHome, workspace, env }) => {
    const dir = join(pilotHome, "system", "security");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "command-policy.yaml"), "version: 1\nmode: nope\ncommands:\n  - terrible\n");
    resetCommandPolicyCache();
    const result = classifyBashPermission(goodCommand("exports/analysis/a-1"), { cwd: workspace, env });
    assert.equal(result.type, "ask");
  });
});

test("an administrator can disable data-analysis.run in the policy file", async () => {
  await withWorkspace(async ({ pilotHome, workspace, env }) => {
    const dir = join(pilotHome, "system", "security");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "command-policy.yaml"),
      [
        "version: 1",
        "mode: registered_only",
        "commands:",
        "  - id: data-analysis.run",
        "    enabled: false",
        "    allowedOptions: [--script, --input, --out, --timeout, --mem-mb]",
        "    inputRoots: [inbox, scratch]",
        "    outputRoots: [exports]",
        "    writable: true",
        "    networkRuleIds: []",
        "    timeoutMs: 600000",
        "",
      ].join("\n"),
    );
    resetCommandPolicyCache();
    const result = classifyBashPermission(goodCommand("exports/analysis/a-1"), { cwd: workspace, env });
    assert.equal(result.type, "ask");
  });
});
