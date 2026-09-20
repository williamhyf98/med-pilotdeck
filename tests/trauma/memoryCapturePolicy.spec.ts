/**
 * Task 7 —— 战创伤 feedback_only 写入。
 *
 * 运行：pnpm exec tsx --test tests/trauma/memoryCapturePolicy.spec.ts
 *
 * 必测项（计划 Task 7）：
 *   - 一段包含生命体征的战创伤对话跑完后，长期记忆里不出现任何生命体征数值
 *   - 即使人为把分类结果篡改为 `project`，`allowedTypes` 硬闸仍然拦住，无写入
 * 两条防线不同，测试也分开：前者测策略层（本模块），后者测硬闸（Task 5）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { MemoryDomainFacade } from "../../src/context/memory/MemoryDomainFacade.js";
import type { MemoryScopeIdentity } from "../../src/context/memory/MemoryScopeIdentity.js";
import { LlmMemoryExtractor } from "../../src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.js";
import { WAR_TRAUMA_PROFILE } from "../../src/context/memory/edgeclaw-memory-core/src/core/skills/prompts/warTrauma.js";
import {
  createTraumaMemoryCaptureSink,
  describeTraumaMemoryCaptureDecision,
  evaluateTraumaMemoryCapture,
  resolveTraumaMemoryCaptureMode,
  TRAUMA_MEMORY_CAPTURE_ELIGIBLE_TURNS_ERROR,
} from "../../src/trauma/memory/TraumaMemoryCapturePolicy.js";
import type { ValidatedTraumaPreference } from "../../src/trauma/memory/TraumaPreferencePolicy.js";

function decide(userText: string, overrides: {
  mode?: "off" | "feedback_only";
  turnStatus?: "completed" | "errored" | "aborted" | "incomplete";
} = {}) {
  return evaluateTraumaMemoryCapture({
    mode: overrides.mode ?? "feedback_only",
    userText,
    turnStatus: overrides.turnStatus ?? "completed",
    scope: "trauma_med/case-a",
  });
}

// ── 策略模式解析 ────────────────────────────────────────────────────────────

test("默认策略是 feedback_only", () => {
  assert.equal(resolveTraumaMemoryCaptureMode(undefined), "feedback_only");
  assert.equal(resolveTraumaMemoryCaptureMode(""), "feedback_only");
  assert.equal(resolveTraumaMemoryCaptureMode("off"), "off");
  assert.equal(resolveTraumaMemoryCaptureMode("feedback_only"), "feedback_only");
});

test("eligible_turns 被显式拒绝，不做静默降级", () => {
  assert.throws(
    () => resolveTraumaMemoryCaptureMode("eligible_turns"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, TRAUMA_MEMORY_CAPTURE_ELIGIBLE_TURNS_ERROR);
      return true;
    },
  );
});

test("非法策略值报错", () => {
  assert.throws(() => resolveTraumaMemoryCaptureMode("all"));
  assert.throws(() => resolveTraumaMemoryCaptureMode(3));
});

// ── 必测 1：生命体征绝不进入长期记忆 ─────────────────────────────────────────

const VITALS_TURN = [
  "伤员王某，左下肢开放性骨折，收缩压 80mmHg，心率 130 次/分，GCS 12 分。",
  "以后回答请先给结论再给依据，不要长篇铺垫。",
  "现场已上止血带，准备后送。",
].join("");

test("必测：含生命体征的对话跑完后，留存内容里没有任何生命体征数值", () => {
  const decision = decide(VITALS_TURN);
  assert.equal(decision.capture, true, "这一轮里有明确的协作规则，应当有留存");
  if (!decision.capture) return;

  for (const forbidden of [
    "80mmHg", "80", "130", "GCS", "12 分",
    "收缩压", "心率", "骨折", "止血带", "伤员", "王某", "后送",
  ]) {
    assert.ok(
      !decision.text.includes(forbidden),
      `留存内容不得包含临床信息「${forbidden}」，实际：${decision.text}`,
    );
  }
  assert.match(decision.text, /先给结论再给依据/u, "协作规则本身应当被保留");
  assert.equal(decision.droppedSegments, 2, "两句临床语句应当被剔除");
});

test("整轮都是临床内容时不写入，原因为 clinical_content_only", () => {
  const decision = decide("伤员心率 130 次/分，收缩压 80mmHg。已建立静脉通路。");
  assert.equal(decision.capture, false);
  if (decision.capture) return;
  assert.equal(decision.reason, "clinical_content_only");
});

test("同一句里临床与 feedback 信号并存时，拒绝方胜出", () => {
  // 「以后」是 feedback 信号，「血压」是临床信号——整句丢弃。
  const decision = decide("以后汇报时要带上血压数值。");
  assert.equal(decision.capture, false);
  if (decision.capture) return;
  assert.equal(decision.reason, "clinical_content_only");
});

// ── 接受什么：明确纠错、展示偏好、汇报格式、工作流规则 ───────────────────────

test("四类可留存内容都能被识别", () => {
  const cases: Array<[string, RegExp]> = [
    ["你上一轮说错了，我问的不是这个。", /说错/u],
    ["以后都用中文回答，不要夹英文术语。", /用中文/u],
    ["汇报格式改成先结论后依据，分点列出。", /格式/u],
    ["每次推演结束请顺带给出下一步建议。", /每次/u],
  ];
  for (const [text, expected] of cases) {
    const decision = decide(text);
    assert.equal(decision.capture, true, `应当留存：${text}`);
    if (!decision.capture) continue;
    assert.match(decision.text, expected);
  }
});

test("普通提问没有 feedback 信号，不写入", () => {
  const decision = decide("张力性气胸应该怎么处理？");
  assert.equal(decision.capture, false);
});

// ── 不捕获的轮次 ────────────────────────────────────────────────────────────

test("off 策略下任何内容都不写入", () => {
  const decision = decide("以后请先给结论。", { mode: "off" });
  assert.equal(decision.capture, false);
  if (decision.capture) return;
  assert.equal(decision.reason, "policy_off");
});

test("errored / aborted / incomplete 的轮次默认不捕获", () => {
  for (const turnStatus of ["errored", "aborted", "incomplete"] as const) {
    const decision = decide("以后请先给结论。", { turnStatus });
    assert.equal(decision.capture, false, `${turnStatus} 不应写入`);
    if (decision.capture) continue;
    assert.equal(decision.reason, "turn_not_completed");
  }
});

test("空输入不写入", () => {
  const decision = decide("   ");
  assert.equal(decision.capture, false);
  if (decision.capture) return;
  assert.equal(decision.reason, "empty_input");
});

// ── 脱敏（Task 3） ──────────────────────────────────────────────────────────

test("留存前执行 PHI 脱敏", () => {
  const decision = decide("以后有问题打我手机 13800138000，别走系统消息。");
  assert.equal(decision.capture, true);
  if (!decision.capture) return;
  assert.ok(!decision.text.includes("13800138000"), "手机号必须脱敏");
  assert.match(decision.text, /已脱敏/u);
  assert.ok(decision.redactedCount >= 1);
  assert.ok(decision.redactedHits.includes("phone-cn"));
});

// ── 审计日志 ────────────────────────────────────────────────────────────────

test("审计日志包含 policy、原因、被删除字段数、目标 scope", () => {
  const captured = describeTraumaMemoryCaptureDecision(
    decide(VITALS_TURN),
    "trauma_med/case-a",
  );
  assert.match(captured, /policy=feedback_only/u);
  assert.match(captured, /reason=feedback_captured/u);
  assert.match(captured, /dropped=2/u);
  assert.match(captured, /scope=trauma_med\/case-a/u);

  // 不含临床语句、也没有 feedback 信号 —— 与上面的 clinical 情形要能区分开。
  const skipped = describeTraumaMemoryCaptureDecision(
    decide("这个流程后面还有别的步骤吗？"),
    "trauma_med/case-a",
  );
  assert.match(skipped, /policy=feedback_only/u);
  assert.match(skipped, /reason=no_feedback_signal/u);
  assert.match(skipped, /scope=trauma_med\/case-a/u);

  // 含临床语句时报 clinical_content_only，便于审计区分「丢过病例内容」。
  const clinical = describeTraumaMemoryCaptureDecision(
    decide("张力性气胸怎么处理？"),
    "trauma_med/case-a",
  );
  assert.match(clinical, /reason=clinical_content_only/u);
});

// ── sink：策略 + 写入端组合 ─────────────────────────────────────────────────

function identity(projectId: string): MemoryScopeIdentity {
  return {
    projectId,
    projectType: "war_trauma",
    projectTypeKey: "trauma_med",
  };
}

function facadeWithRecorder() {
  const writes: Array<{ messages: readonly unknown[]; sessionKey: string }> = [];
  const facade = new MemoryDomainFacade({
    identity: identity("trauma_med/case-a"),
    service: {
      async retrieveContext() {
        return {};
      },
      captureTurn(rawMessages, input) {
        writes.push({ messages: rawMessages, sessionKey: input.sessionKey });
        return { captured: true };
      },
    },
  });
  return { facade, writes };
}

test("sink 只把过滤后的文本作为 user 单条消息写入", () => {
  const { facade, writes } = facadeWithRecorder();
  const logs: string[] = [];
  const sink = createTraumaMemoryCaptureSink({
    writer: facade,
    mode: "feedback_only",
    scope: "trauma_med/case-a",
    logger: { info: (line) => logs.push(String(line)) },
  });

  const preferences: ValidatedTraumaPreference[] = [{
    sourceSpan: "以后回答请先给结论再给依据，不要长篇铺垫",
    directive: "以后回答请先给结论再给依据，不要长篇铺垫。",
    category: "format",
    redactedCount: 0,
    redactedHits: [],
  }];
  sink({ sessionId: "web:s1", preferences, turnStatus: "completed" });

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.sessionKey, "web:s1");
  assert.deepEqual(writes[0]?.messages, [
    { role: "user", content: "以后回答请先给结论再给依据，不要长篇铺垫。" },
  ]);
  assert.equal(logs.length, 1, "每次捕获记一行审计日志");
  assert.match(logs[0] ?? "", /written=true/u);
});

test("sink 在跳过时不写入；off 策略不刷日志", () => {
  const { facade, writes } = facadeWithRecorder();
  const logs: string[] = [];
  const logger = { info: (line: unknown) => logs.push(String(line)) };

  createTraumaMemoryCaptureSink({ writer: facade, mode: "feedback_only", scope: "s", logger })(
    { sessionId: "web:s1", preferences: [], turnStatus: "completed" },
  );
  assert.equal(writes.length, 0);
  assert.equal(logs.length, 1, "跳过也要留一条审计记录");

  createTraumaMemoryCaptureSink({ writer: facade, mode: "off", scope: "s", logger })(
    { sessionId: "web:s1", preferences: [], turnStatus: "completed" },
  );
  assert.equal(writes.length, 0);
  assert.equal(logs.length, 1, "policy_off 是稳定状态，不逐轮刷屏");
});

test("写入端抛错时 sink 不抛出", () => {
  const warnings: unknown[][] = [];
  const logger = { warn: (...args: unknown[]) => warnings.push(args) };
  const facade = new MemoryDomainFacade({
    identity: identity("trauma_med/case-a"),
    logger,
    service: {
      async retrieveContext() {
        return {};
      },
      captureTurn() {
        throw new Error("sqlite is locked");
      },
    },
  });
  const sink = createTraumaMemoryCaptureSink({
    writer: facade,
    mode: "feedback_only",
    scope: "s",
    logger,
  });

  assert.doesNotThrow(() => {
    sink({
      sessionId: "web:s1",
      preferences: [{
        sourceSpan: "以后先给结论",
        directive: "以后先给结论。",
        category: "format",
        redactedCount: 0,
        redactedHits: [],
      }],
      turnStatus: "completed",
    });
  });
  // facade 自己吞掉异常并记 warning，sink 拿到 written=false。
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.join(" ")), /sqlite is locked/u);
});

// ── 必测 2：绕过验证 —— 篡改分类结果也写不进去 ──────────────────────────────

test("必测（绕过验证）：分类被篡改为 project 时，allowedTypes 硬闸仍然拦住", async () => {
  const infos: string[] = [];
  const extractor = new LlmMemoryExtractor(
    {},
    undefined,
    { info: (line: unknown) => { infos.push(String(line)); } },
    WAR_TRAUMA_PROFILE,
  );

  // createMemoryNote 是私有方法；这里刻意绕过封装直接调用，
  // 模拟「分类结果被篡改」——硬闸必须在任何模型调用之前就拦下。
  const createMemoryNote = (
    extractor as unknown as {
      createMemoryNote(input: Record<string, unknown>): Promise<unknown>;
    }
  ).createMemoryNote.bind(extractor);

  for (const kind of ["project", "user"] as const) {
    const note = await createMemoryNote({
      kind,
      timestamp: new Date().toISOString(),
      focusUserTurn: { role: "user", content: "伤员收缩压 80mmHg。" },
      batchContextMessages: [],
      classification: { type: kind, reason: "forged", evidence: "forged" },
    });
    assert.equal(note, null, `kind="${kind}" 必须被硬闸丢弃`);
  }

  assert.equal(infos.length, 2, "每次拦截都要留痕");
  assert.match(infos[0] ?? "", /not allowed by profile "war_trauma"/u);

  // 对照：feedback 在 allowedTypes 内，硬闸不拦它。这里没有可用模型，
  // 所以它一定拿不到笔记；判据是**没有产生拦截日志**——说明它越过了硬闸，
  // 是在更后面的模型调用阶段失败的，而不是在第一行被丢弃。
  await createMemoryNote({
    kind: "feedback",
    timestamp: new Date().toISOString(),
    focusUserTurn: { role: "user", content: "以后先给结论。" },
    batchContextMessages: [],
    classification: { type: "feedback", reason: "ok", evidence: "ok" },
  }).catch(() => null);
  assert.equal(infos.length, 2, "feedback 不应产生拦截记录");
});
