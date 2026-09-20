/**
 * Task 6 —— 战创伤只读接入全局画像与项目记忆。
 *
 * 运行：pnpm exec tsx --test tests/trauma/memoryContext.spec.ts
 *
 * 必测项（计划 Task 6）：
 *   - 其他项目的记忆不会被召回
 *   - 其他病例的 Case State 不会被召回
 * 这两条的防线不同，测试也分开写：
 *   前者靠「facade 绑定的是本项目的 service 实例」，
 *   后者靠「facade 只投影 User Profile 与 Feedback Memory 两段」。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryDomainFacade,
  type MemoryDomainServiceLike,
} from "../../src/context/memory/MemoryDomainFacade.js";
import type { MemoryScopeIdentity } from "../../src/context/memory/MemoryScopeIdentity.js";
import {
  isEmptyTraumaMemoryContext,
  renderTraumaMemoryContext,
  resolveTraumaMemoryContext,
  TRAUMA_MEMORY_PRIORITY_RULE,
  resolveTraumaPresentationMemory,
} from "../../src/trauma/memory/TraumaMemoryContext.js";

function identity(projectId: string): MemoryScopeIdentity {
  return {
    projectId,
    projectType: "war_trauma",
    projectTypeKey: "trauma_med",
    sessionId: "session-1",
  };
}

/** 固定返回一段 systemContext 的 service 替身。 */
function serviceReturning(systemContext: string): MemoryDomainServiceLike {
  return {
    async retrieveContext() {
      return { systemContext };
    },
  };
}

function presentationServiceReturning(memory: {
  globalProfile?: string;
  projectFeedback?: string;
}): MemoryDomainServiceLike {
  return {
    async retrieveContext() {
      throw new Error("deterministic presentation reads must not use semantic retrieval");
    },
    readPresentationMemory() {
      return memory;
    },
  };
}

const FULL_RECALL = [
  "## ClawXMemory Recall",
  "These are retrieved long-term memory references for the current turn.",
  "",
  "## User Profile",
  "## 身份背景",
  "- 急诊外科主治医师",
  "## 专业领域",
  "- 创伤复苏",
  "",
  "## Project Meta",
  "- 项目名：战创伤推演",
  "",
  "## Project Memory",
  "- 伤员王某，左下肢开放性骨折，收缩压 80mmHg",
  "",
  "## Feedback Memory",
  "## Rule",
  "- 回答先给结论再给依据",
].join("\n");

// ── 必测 1：其他病例的 Case State / 项目记忆不会被召回 ───────────────────────

test("facade 只投影 User Profile 与 Feedback Memory，丢弃 Project 段", async () => {
  const facade = new MemoryDomainFacade({
    service: serviceReturning(FULL_RECALL),
    identity: identity("trauma_med/case-a"),
  });

  const result = await facade.read({ query: "该伤员如何处置" });
  assert.ok(result, "应当召回到内容");

  assert.match(result.globalProfile ?? "", /急诊外科主治医师/u);
  assert.match(result.projectFeedback ?? "", /先给结论再给依据/u);

  // Project Meta / Project Memory 两段对战创伤而言就是病例内容，必须整段丢弃。
  const combined = `${result.globalProfile ?? ""}\n${result.projectFeedback ?? ""}`;
  assert.doesNotMatch(combined, /伤员王某/u, "其他病例的伤情不得进入召回结果");
  assert.doesNotMatch(combined, /开放性骨折/u, "其他病例的伤情不得进入召回结果");
  assert.doesNotMatch(combined, /80mmHg/u, "其他病例的生命体征不得进入召回结果");
  assert.doesNotMatch(combined, /项目名/u, "Project Meta 不得进入召回结果");
});

test("facade 确定性读取展示记忆，不依赖 query 或语义召回", () => {
  const facade = new MemoryDomainFacade({
    service: presentationServiceReturning({
      globalProfile: "## 专业领域\n- 战创伤复苏",
      projectFeedback: "## Rule\n- 先给结论",
    }),
    identity: identity("trauma_med/case-a"),
  });

  const result = facade.readPresentationMemory();
  assert.match(result?.globalProfile ?? "", /战创伤复苏/u);
  assert.match(result?.projectFeedback ?? "", /先给结论/u);
});

test("facade 对确定性展示记忆继续执行脱敏和 Feedback 优先预算", () => {
  const facade = new MemoryDomainFacade({
    service: presentationServiceReturning({
      globalProfile: `联系人 13800138000 ${"画".repeat(200)}`,
      projectFeedback: "先给结论",
    }),
    identity: identity("trauma_med/case-a"),
    sectionCharLimit: 80,
    totalCharLimit: 80,
  });

  const result = facade.readPresentationMemory();
  assert.equal(result?.projectFeedback, "先给结论");
  assert.doesNotMatch(result?.globalProfile ?? "", /13800138000/u);
  assert.match(result?.globalProfile ?? "", /已脱敏/u);
});

test("只有 Project 段时视为无召回", async () => {
  const facade = new MemoryDomainFacade({
    service: serviceReturning([
      "## Project Memory",
      "- 伤员李某，张力性气胸",
    ].join("\n")),
    identity: identity("trauma_med/case-a"),
  });

  assert.equal(await facade.read({ query: "气胸如何处置" }), null);
});

// ── 必测 2：其他项目的记忆不会被召回 ─────────────────────────────────────────

test("facade 只能读到自己绑定的 service，跨项目召回不可达", async () => {
  const projectA = serviceReturning([
    "## Feedback Memory",
    "- A 项目约定：使用公制单位",
  ].join("\n"));
  const projectB = serviceReturning([
    "## Feedback Memory",
    "- B 项目约定：使用英制单位",
  ].join("\n"));

  const facadeA = new MemoryDomainFacade({
    service: projectA,
    identity: identity("trauma_med/project-a"),
  });
  const facadeB = new MemoryDomainFacade({
    service: projectB,
    identity: identity("trauma_med/project-b"),
  });

  const resultA = await facadeA.read({ query: "单位约定" });
  const resultB = await facadeB.read({ query: "单位约定" });

  assert.match(resultA?.projectFeedback ?? "", /公制/u);
  assert.doesNotMatch(resultA?.projectFeedback ?? "", /英制/u, "不得读到 B 项目的记忆");

  assert.match(resultB?.projectFeedback ?? "", /英制/u);
  assert.doesNotMatch(resultB?.projectFeedback ?? "", /公制/u, "不得读到 A 项目的记忆");
});

test("facade 把项目路径作为 workspaceHint 传给 service", async () => {
  const seen: Array<string | undefined> = [];
  const facade = new MemoryDomainFacade({
    service: {
      async retrieveContext(_query, options) {
        seen.push(options?.workspaceHint);
        return { systemContext: "## Feedback Memory\n- 约定" };
      },
    },
    identity: { ...identity("trauma_med/p"), projectPath: "/home/u/trauma_med/p" },
  });

  await facade.read({ query: "约定" });
  assert.deepEqual(seen, ["/home/u/trauma_med/p"]);
});

// ── 脱敏与长度限制（复用 Task 3 的策略） ─────────────────────────────────────

test("召回内容执行 PHI 脱敏", async () => {
  const facade = new MemoryDomainFacade({
    service: serviceReturning([
      "## User Profile",
      "- 联系人手机 13800138000，身份证 11010119900307123X",
    ].join("\n")),
    identity: identity("trauma_med/p"),
  });

  const result = await facade.read({ query: "联系方式" });
  const profile = result?.globalProfile ?? "";
  assert.doesNotMatch(profile, /13800138000/u, "手机号必须脱敏");
  assert.doesNotMatch(profile, /11010119900307123X/u, "身份证号必须脱敏");
  assert.match(profile, /已脱敏/u, "脱敏后应保留占位标记");
});

test("单段超长时截断并标记", async () => {
  const facade = new MemoryDomainFacade({
    service: serviceReturning(`## Feedback Memory\n${"约".repeat(500)}`),
    identity: identity("trauma_med/p"),
    sectionCharLimit: 100,
  });

  const result = await facade.read({ query: "约定" });
  const feedback = result?.projectFeedback ?? "";
  assert.ok(feedback.length < 200, `截断后长度应受限，实际 ${feedback.length}`);
  assert.match(feedback, /已截断/u);
});

test("总长预算耗尽时全局画像让位于项目 Feedback", async () => {
  const facade = new MemoryDomainFacade({
    service: serviceReturning([
      "## User Profile",
      "画".repeat(200),
      "## Feedback Memory",
      "反".repeat(200),
    ].join("\n")),
    identity: identity("trauma_med/p"),
    sectionCharLimit: 150,
    totalCharLimit: 150,
  });

  const result = await facade.read({ query: "约定" });
  assert.ok(result?.projectFeedback, "Feedback 优先占用预算");
  assert.equal(result?.globalProfile, undefined, "预算耗尽后全局画像应被省略");
});

// ── 失败只记 warning，不中断 ────────────────────────────────────────────────

test("service 抛错时返回 null 并记 warning", async () => {
  const warnings: unknown[][] = [];
  const facade = new MemoryDomainFacade({
    service: {
      async retrieveContext() {
        throw new Error("sqlite is locked");
      },
    },
    identity: identity("trauma_med/p"),
    logger: { warn: (...args) => warnings.push(args) },
  });

  assert.equal(await facade.read({ query: "任意" }), null);
  assert.equal(warnings.length, 1, "失败必须记一条 warning");
  assert.match(String(warnings[0]?.join(" ")), /sqlite is locked/u);
});

test("空 query 与空召回都返回 null", async () => {
  const facade = new MemoryDomainFacade({
    service: serviceReturning(""),
    identity: identity("trauma_med/p"),
  });

  assert.equal(await facade.read({ query: "   " }), null);
  assert.equal(await facade.read({ query: "有效问题" }), null);
});

test("已 abort 的信号直接返回 null，不触达 service", async () => {
  let called = 0;
  const controller = new AbortController();
  controller.abort();
  const facade = new MemoryDomainFacade({
    service: {
      async retrieveContext() {
        called += 1;
        return { systemContext: "## Feedback Memory\n- 约定" };
      },
    },
    identity: identity("trauma_med/p"),
  });

  assert.equal(await facade.read({ query: "约定", signal: controller.signal }), null);
  assert.equal(called, 0);
});

// ── 渲染与 provider 兜底 ────────────────────────────────────────────────────

test("渲染时 Feedback 排在全局画像之前", () => {
  const rendered = renderTraumaMemoryContext({
    globalProfile: "- 创伤外科医师",
    projectFeedback: "- 先给结论",
  });
  assert.ok(rendered);
  assert.ok(
    rendered.indexOf("当前项目 Feedback") < rendered.indexOf("全局用户画像"),
    "Feedback 优先级更高，应排在前面",
  );
});

test("无内容时渲染为 null", () => {
  assert.equal(renderTraumaMemoryContext(null), null);
  assert.equal(renderTraumaMemoryContext({}), null);
  assert.equal(renderTraumaMemoryContext({ globalProfile: "  " }), null);
  assert.ok(isEmptyTraumaMemoryContext({ projectFeedback: "" }));
});

test("provider 抛错时 resolveTraumaMemoryContext 返回 null 并记 warning", async () => {
  const warnings: unknown[][] = [];
  const result = await resolveTraumaMemoryContext(
    async () => {
      throw new Error("provider exploded");
    },
    { query: "任意" },
    { warn: (...args) => warnings.push(args) },
  );

  assert.equal(result, null);
  assert.equal(warnings.length, 1);
});

test("provider 缺省时返回 null", async () => {
  assert.equal(await resolveTraumaMemoryContext(undefined, { query: "任意" }), null);
});

test("确定性展示记忆 provider 失败时返回 null", async () => {
  const warnings: unknown[][] = [];
  const result = await resolveTraumaPresentationMemory(
    () => {
      throw new Error("presentation memory failed");
    },
    { warn: (...args) => warnings.push(args) },
  );

  assert.equal(result, null);
  assert.equal(warnings.length, 1);
});

test("旧记忆上下文规则仍明确临床信息优先级", () => {
  assert.match(
    TRAUMA_MEMORY_PRIORITY_RULE,
    /当前轮明确输入 > 当前病例 Case State > 已验证的医学知识\/RAG 证据 > 当前项目 Feedback > 全局用户画像/u,
  );
});
