// @ts-nocheck
// data-analysis 的拒绝/超时/OOM 必须在 bash 工具层留审计（spec §4 / §11）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PermissionRuntime } from "../../src/permission/index.js";
import { createBashTool } from "../../src/tool/builtin/bash.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import {
  analysisAuditEvent,
  isAnalysisCommand,
  parseAnalysisReport,
} from "../../src/security/audit/analysisOutcome.js";

const ENTRY = "bash /srv/app/skills/data-analysis/scripts/analysis.sh";
const RUN = `${ENTRY} run --script scratch/work/t1/analysis.py --input inbox/batch1 --out exports/analysis/a`;

function createRuntime(runner) {
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner }));
  return new ToolRuntime(registry, new PermissionRuntime());
}

function context(pilotHome) {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    env: { ...process.env, PILOT_HOME: pilotHome },
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-11-11T10:00:00.000Z"),
  };
}

async function withHome(fn) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-analysis-audit-"));
  const pilotHome = join(root, "users", "7");
  try {
    await mkdir(pilotHome, { recursive: true });
    await fn({ pilotHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function auditFile(pilotHome) {
  return join(pilotHome, "system", "audit", "2026-11-11.jsonl");
}

/** 只取 analysis.* 事件：同一条命令还会写 bash.registered_allowed（命令白名单命中）。 */
async function readAudit(pilotHome) {
  try {
    const text = await readFile(auditFile(pilotHome), "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => String(line.action).startsWith("analysis."));
  } catch {
    return [];
  }
}

async function runBash({ command, exitCode, stdout = "", timedOut = false, pilotHome }) {
  const runtime = createRuntime({
    async run() {
      return { exitCode, stdout, stderr: "", timedOut, durationMs: 5 };
    },
  });
  try {
    return await runtime.execute({ id: "call-1", name: "bash", input: { command } }, context(pilotHome));
  } catch (error) {
    return { error };
  }
}

test("isAnalysisCommand 只认 data-analysis 的唯一入口", () => {
  assert.equal(isAnalysisCommand(RUN), true);
  assert.equal(isAnalysisCommand(`${ENTRY} check --json`), true);
  assert.equal(isAnalysisCommand("bash skills/pdf/scripts/pdf.sh run"), false);
  assert.equal(isAnalysisCommand("python3 scratch/work/t1/analysis.py"), false);
  assert.equal(isAnalysisCommand(""), false);
});

test("parseAnalysisReport 取最后一行带 status 的 JSON，忽略噪声行", () => {
  const stdout = ["loading…", '{"status":"ok"}', 'not json', '{"status":"blocked","violations":[]}'].join("\n");
  assert.deepEqual(parseAnalysisReport(stdout), { status: "blocked", violations: [] });
  assert.equal(parseAnalysisReport("plain text only"), null);
});

test("静态拒绝 → analysis.rejected，reason 带命中的规则", () => {
  const event = analysisAuditEvent({
    command: RUN,
    stdout: JSON.stringify({
      status: "rejected",
      violations: [
        { line: 1, rule: "blocked-import", detail: "subprocess" },
        { line: 2, rule: "blocked-call", detail: "os.system" },
      ],
    }),
  });
  assert.equal(event?.action, "analysis.rejected");
  assert.equal(event?.decision, "deny");
  assert.equal(event?.reason, "static:blocked-import,blocked-call");
  assert.equal(event?.meta.violations, 2);
});

test("运行期护栏 → analysis.blocked，reason 带事件名", () => {
  const event = analysisAuditEvent({
    command: RUN,
    stdout: JSON.stringify({
      status: "blocked",
      runnerExitCode: 8,
      violations: [{ rule: "runtime-guard", event: "os.system", detail: "…" }],
    }),
  });
  assert.equal(event?.action, "analysis.blocked");
  assert.equal(event?.reason, "runtime:runtime-guard");
  assert.equal(event?.meta.runnerExitCode, 8);
});

test("超时与 OOM 分别记 analysis.timeout / analysis.oom", () => {
  assert.equal(
    analysisAuditEvent({ command: RUN, stdout: '{"status":"timeout"}', timedOut: true })?.action,
    "analysis.timeout",
  );
  assert.equal(
    analysisAuditEvent({ command: RUN, stdout: '{"status":"timeout"}' })?.action,
    "analysis.timeout",
  );
  assert.equal(
    analysisAuditEvent({ command: RUN, stdout: '{"status":"oom","oom":true}' })?.action,
    "analysis.oom",
  );
});

test("成功与普通失败不写审计（避免噪声淹没真拒绝）", () => {
  assert.equal(analysisAuditEvent({ command: RUN, stdout: '{"status":"ok"}', timedOut: false }), null);
  assert.equal(analysisAuditEvent({ command: RUN, stdout: '{"status":"failed"}' }), null);
  assert.equal(analysisAuditEvent({ command: "echo hi", stdout: '{"status":"rejected"}' }), null);
});

test("bash 工具：被拒的分析命令会落一行 analysis.rejected 审计", async () => {
  await withHome(async ({ pilotHome }) => {
    await runBash({
      command: RUN,
      exitCode: 3,
      stdout: JSON.stringify({ status: "rejected", violations: [{ line: 1, rule: "blocked-import" }] }),
      pilotHome,
    });
    const lines = await readAudit(pilotHome);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "analysis.rejected");
    assert.equal(lines[0].decision, "deny");
    assert.match(lines[0].reason, /blocked-import/);
  });
});

test("bash 工具：超时也留痕，且不影响原来的 tool_timeout 语义", async () => {
  await withHome(async ({ pilotHome }) => {
    const result = await runBash({
      command: RUN,
      exitCode: null,
      stdout: "",
      timedOut: true,
      pilotHome,
    });
    assert.equal(result.error?.code ?? result.error?.name, "tool_timeout");
    const lines = await readAudit(pilotHome);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "analysis.timeout");
  });
});

test("bash 工具：成功或非分析命令都不落审计", async () => {
  await withHome(async ({ pilotHome }) => {
    await runBash({ command: RUN, exitCode: 0, stdout: '{"status":"ok"}', pilotHome });
    await runBash({ command: "exit 3", exitCode: 3, stdout: "", pilotHome });
    const lines = await readAudit(pilotHome);
    assert.deepEqual(lines, []);
  });
});
