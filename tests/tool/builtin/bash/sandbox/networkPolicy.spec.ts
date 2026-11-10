import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNetworkPolicySupported,
  extractSkillNames,
  isSingleSimpleInvocation,
  resolveCommandNetworkPolicy,
} from "../../../../../src/tool/builtin/bash/sandbox/networkPolicy.js";

test("extracts skill names from absolute and relative script paths", () => {
  assert.deepEqual(
    extractSkillNames("/app/skills/pptx/scripts/pptx.sh make --out a.pptx"),
    ["pptx"],
  );
  assert.deepEqual(extractSkillNames("skills/docx/scripts/docx.sh deliver"), ["docx"]);
  assert.deepEqual(extractSkillNames("cd skills/spreadsheets/scripts && ./x.sh"), ["spreadsheets"]);
  // 只有目录名、没有子路径的命令不算（真实调用一定带 scripts/ 子路径）
  assert.deepEqual(extractSkillNames("cd skills/spreadsheets && ls"), []);
});

test("does not treat a look-alike directory as a skill (no privilege escalation)", () => {
  assert.deepEqual(extractSkillNames("bash /tmp/foo/myskills/docx/evil.sh"), []);
  assert.deepEqual(extractSkillNames("bash /tmp/skillsx/docx/evil.sh"), []);
  assert.deepEqual(extractSkillNames("echo skills/"), []);
});

test("commands without any skill fall back to the global policy", () => {
  assert.equal(resolveCommandNetworkPolicy("ls -la", "none", []).allowNetwork, false);
  assert.equal(resolveCommandNetworkPolicy("ls -la", "open", []).allowNetwork, true);
});

test("a whitelisted skill may use the network even when the global policy is none", () => {
  const decision = resolveCommandNetworkPolicy("bash /app/skills/docx/scripts/docx.sh render x.docx", "none", [
    "docx",
    "pptx",
  ]);
  assert.equal(decision.allowNetwork, true);
  assert.equal(decision.policy, "open");
  assert.deepEqual(decision.skills, ["docx"]);
});

test("a skill outside the whitelist stays isolated under network: none", () => {
  const decision = resolveCommandNetworkPolicy(
    "bash /app/skills/data-analysis/scripts/analysis.sh run a.py",
    "none",
    ["docx", "pptx", "spreadsheets"],
  );
  assert.equal(decision.allowNetwork, false);
  assert.equal(decision.policy, "none");
});

test("mixing a whitelisted and a non-whitelisted skill stays isolated (fail-closed)", () => {
  const decision = resolveCommandNetworkPolicy(
    "bash /app/skills/docx/scripts/docx.sh make && python3 skills/data-analysis/x.py",
    "none",
    ["docx"],
  );
  assert.equal(decision.allowNetwork, false);
});

test("a whitelisted skill cannot smuggle arbitrary code via shell chaining", () => {
  const cases = [
    "bash /app/skills/docx/scripts/docx.sh make && python3 evil.py",
    "bash /app/skills/docx/scripts/docx.sh make | tee log.txt",
    "bash /app/skills/docx/scripts/docx.sh make > out.json",
    "bash /app/skills/docx/scripts/docx.sh make; python3 evil.py",
    "bash /app/skills/docx/scripts/docx.sh make $(python3 evil.py)",
  ];
  for (const command of cases) {
    const decision = resolveCommandNetworkPolicy(command, "none", ["docx"]);
    assert.equal(decision.allowNetwork, false, `should stay isolated: ${command}`);
  }
});

test("a leading `cd <dir> &&` prefix is tolerated for whitelisted skills", () => {
  const decision = resolveCommandNetworkPolicy(
    'cd "/data/my work" && bash /app/skills/docx/scripts/docx.sh make',
    "none",
    ["docx"],
  );
  assert.equal(decision.allowNetwork, true);
});

test("isSingleSimpleInvocation rejects compound commands", () => {
  assert.equal(isSingleSimpleInvocation("bash /app/skills/docx/scripts/docx.sh make"), true);
  assert.equal(isSingleSimpleInvocation("cd /app && bash x.sh"), true);
  assert.equal(isSingleSimpleInvocation("cd /app && bash x.sh && rm -rf y"), false);
  assert.equal(isSingleSimpleInvocation(""), false);
});

test("allowlist is rejected until it is implemented instead of degrading to open", () => {
  assert.throws(() => assertNetworkPolicySupported("allowlist", "linux"), /allowlist 尚未实现/u);
  assert.throws(() => assertNetworkPolicySupported("allowlist", "darwin"), /allowlist 尚未实现/u);
  assert.doesNotThrow(() => assertNetworkPolicySupported("none", "linux"));
  assert.doesNotThrow(() => assertNetworkPolicySupported("open", "darwin"));
});
