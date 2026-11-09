import assert from "node:assert/strict";
import test from "node:test";
import { REGISTERED_COMMANDS, parseCommandPolicy } from "../../src/security/policy/parseCommandPolicy.js";

test("missing command policy enables only built-in workspace checks and bundled business operations", () => {
  const defaults = parseCommandPolicy(undefined);
  assert.equal(defaults.mode, "registered_only");
  assert.equal(defaults.commands.some((rule) => rule.id === "workspace.pwd" && rule.enabled), true);
  assert.equal(defaults.commands.some((rule) => rule.id === "pdf.make" && rule.enabled), true);
  assert.equal(defaults.commands.some((rule) => rule.id === "diagram.make" && rule.enabled), true);
  assert.equal(defaults.commands.some((rule) => rule.id === "pdf.self-test"), false);
});

test("a registered command may only narrow its system-defined limits", () => {
  const policy = parseCommandPolicy({
    version: 1,
    mode: "registered_only",
    commands: [{
      id: "pdf.make", enabled: true, allowedOptions: ["--markdown", "--out"],
      inputRoots: ["scratch"], outputRoots: ["exports"], writable: true,
      networkRuleIds: [], timeoutMs: 30_000,
    }],
  });
  assert.equal(policy.commands[0]?.id, "pdf.make");
  assert.equal(policy.commands[0]?.enabled, true);
});

test("arbitrary programs and maintenance commands are not registry capabilities", () => {
  for (const id of ["python.run", "bash.execute", "pdf.self-test", "docx.fix", "pdf.bootstrap-runtime", "/usr/bin/env"]) {
    assert.throws(() => parseCommandPolicy({
      version: 1, mode: "registered_only",
      commands: [{ id, enabled: true, allowedOptions: [], inputRoots: [], outputRoots: [],
        writable: false, networkRuleIds: [], timeoutMs: 1000 }],
    }), /registered|unknown|Invalid/i, id);
  }
});

test("command policy rejects unknown fields and widened flags, roots, network or duration", () => {
  const base = {
    id: "workspace.pwd", enabled: true, allowedOptions: [], inputRoots: [],
    outputRoots: [], writable: false, networkRuleIds: [], timeoutMs: 1000,
  };
  const invalid = [
    { ...base, executable: "/bin/bash" },
    { ...base, allowedOptions: ["--execute"] },
    { ...base, inputRoots: ["memory"] },
    { ...base, outputRoots: ["exports"] },
    { ...base, writable: true },
    { ...base, networkRuleIds: ["hospital.pacs"] },
    { ...base, timeoutMs: 999_999 },
  ];
  for (const command of invalid) {
    assert.throws(() => parseCommandPolicy({ version: 1, mode: "registered_only", commands: [command] }));
  }
  assert.throws(() => parseCommandPolicy({ version: 1, mode: "allow_all", commands: [] }));
  assert.throws(() => parseCommandPolicy({ version: 1, mode: "registered_only", commands: [], bypass: true }));
  assert.throws(() => parseCommandPolicy({ version: 1, mode: "registered_only", commands: [base, base] }));
});

test("callers cannot widen the system registry by mutating a descriptor", () => {
  assert.equal(Object.isFrozen(REGISTERED_COMMANDS["pdf.make"]), true);
  assert.equal(Object.isFrozen(REGISTERED_COMMANDS["pdf.make"]?.options), true);
});
