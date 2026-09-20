/**
 * `runDueScheduledMaintenance` 的门控回归基线 —— Task 10「Index/Dream 即时化」的安全网。
 *
 * Task 10 会把「回答返回后立即异步执行 Index/Dream」加进来。那个改动很容易
 * 顺手把现有的定时门控一起改坏（尤其是 `intervalMinutes <= 0` 的语义）。
 * 本文件先把**当前行为**钉死，Task 10 只允许新增分支，不允许让下面任何一条失败。
 *
 * 测试手法（不需要 mock 时钟）：
 *   索引的时间锚点由 `getEarliestPendingTimestamp()` 推导，而 `captureTurn` 接受
 *   外部传入的 timestamp。所以「间隔已到」直接用一个很旧的 capture 时间戳模拟即可。
 *   `flush` / `dream` 在实例上被替换成计数桩，全程不触发任何 LLM 调用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EdgeClawMemoryService, type EdgeClawMemoryServiceOptions } from "../src/service.ts";

const MINUTE_MS = 60_000;

/** `AUTO_INDEX_PENDING_DIALOGUE_TURN_THRESHOLD`，service.ts 内为模块私有，此处镜像一份 */
const BACKLOG_THRESHOLD = 20;

interface Harness {
  readonly service: EdgeClawMemoryService;
  /** flush 被调用的次数；调用即视为「索引跑了」 */
  flushCalls: number;
  /** dream 被调用的次数 */
  dreamCalls: number;
}

/**
 * 建一个临时目录里的 service，并把 flush/dream 换成计数桩。
 * 不传 llm 配置——本文件的所有路径都不应该真的调用模型。
 */
function createHarness(
  settings: EdgeClawMemoryServiceOptions["defaultIndexingSettings"],
): { harness: Harness; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ec-maintenance-"));
  const service = new EdgeClawMemoryService({
    workspaceDir: dir,
    ...(settings ? { defaultIndexingSettings: settings } : {}),
  });

  const harness: Harness = { service, flushCalls: 0, dreamCalls: 0 };

  const flushStub: EdgeClawMemoryService["flush"] = async () => {
    harness.flushCalls += 1;
    // 返回一个「什么都没写」的统计：writtenFiles 为 0，才不会推进 dream 锚点，
    // 于是 Dream 门控能被独立观察。
    return {
      capturedSessions: 0,
      writtenFiles: 0,
      writtenUserFiles: 0,
      writtenProjectFiles: 0,
      writtenFeedbackFiles: 0,
      userProfilesUpdated: 0,
      failedSessions: 0,
    };
  };
  service.flush = flushStub;

  // dream 在本文件的所有用例里都**不应该**被调用；真被调用了就让它显式炸掉，
  // 而不是返回一个假的 DreamRunResult 把问题掩盖过去。
  const dreamStub: EdgeClawMemoryService["dream"] = async () => {
    harness.dreamCalls += 1;
    throw new Error("dream 不应在本用例中被触发");
  };
  service.dream = dreamStub;

  return {
    harness,
    cleanup: () => {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 投喂 n 轮对话，时间戳统一设为 `minutesAgo` 分钟之前 */
function captureTurns(service: EdgeClawMemoryService, n: number, minutesAgo: number): void {
  const timestamp = new Date(Date.now() - minutesAgo * MINUTE_MS).toISOString();
  for (let i = 0; i < n; i += 1) {
    service.captureTurn(
      [
        { role: "user", content: `第 ${i} 个问题：患者主诉持续咳嗽两周。` },
        { role: "assistant", content: `第 ${i} 个回答：建议完善胸片与血常规。` },
      ],
      { sessionKey: `session-${i}`, timestamp },
    );
  }
}

async function withHarness(
  settings: EdgeClawMemoryServiceOptions["defaultIndexingSettings"],
  body: (harness: Harness) => Promise<void> | void,
): Promise<void> {
  const { harness, cleanup } = createHarness(settings);
  try {
    await body(harness);
  } finally {
    cleanup();
  }
}

test("autoIndexIntervalMinutes = 0 表示「关闭」而不是「立即执行」", async () => {
  await withHarness({ autoIndexIntervalMinutes: 0, autoDreamIntervalMinutes: 0 }, async (h) => {
    captureTurns(h.service, 1, 24 * 60); // 一天前的待索引内容，时间上早就该跑了
    const result = await h.service.runDueScheduledMaintenance();
    assert.equal(
      result.indexRan,
      false,
      "间隔设为 0 时必须视为关闭定时索引；Task 10 若要改成「立即执行」，"
        + "不能借用这个取值，必须新增独立开关。",
    );
    assert.equal(h.flushCalls, 0);
  });
});

test("有待索引内容且间隔已到 → 执行索引", async () => {
  await withHarness({ autoIndexIntervalMinutes: 30, autoDreamIntervalMinutes: 60 }, async (h) => {
    captureTurns(h.service, 1, 31);
    const result = await h.service.runDueScheduledMaintenance();
    assert.equal(result.indexRan, true);
    assert.equal(h.flushCalls, 1);
  });
});

test("有待索引内容但间隔未到 → 不执行索引", async () => {
  await withHarness({ autoIndexIntervalMinutes: 30, autoDreamIntervalMinutes: 60 }, async (h) => {
    captureTurns(h.service, 1, 1);
    const result = await h.service.runDueScheduledMaintenance();
    assert.equal(result.indexRan, false);
    assert.equal(h.flushCalls, 0);
  });
});

test("完全没有待索引内容 → 不执行索引", async () => {
  await withHarness({ autoIndexIntervalMinutes: 30, autoDreamIntervalMinutes: 60 }, async (h) => {
    const result = await h.service.runDueScheduledMaintenance();
    assert.equal(result.indexRan, false);
    assert.equal(h.flushCalls, 0);
  });
});

test(`积压达到 ${BACKLOG_THRESHOLD} 轮时绕过时间门控`, async () => {
  await withHarness({ autoIndexIntervalMinutes: 0, autoDreamIntervalMinutes: 0 }, async (h) => {
    // 间隔为 0（关闭）+ 时间戳是「刚刚」，两个时间条件都不成立，
    // 唯一能让它跑起来的就是积压阈值——这条断言证明的是那个 `||`。
    captureTurns(h.service, BACKLOG_THRESHOLD, 0);
    const result = await h.service.runDueScheduledMaintenance();
    assert.equal(result.indexRan, true, "积压阈值必须能独立触发索引");
    assert.equal(h.flushCalls, 1);
  });
});

test(`积压 ${BACKLOG_THRESHOLD - 1} 轮（差一轮）时不触发`, async () => {
  await withHarness({ autoIndexIntervalMinutes: 0, autoDreamIntervalMinutes: 0 }, async (h) => {
    captureTurns(h.service, BACKLOG_THRESHOLD - 1, 0);
    const result = await h.service.runDueScheduledMaintenance();
    assert.equal(result.indexRan, false, "阈值是 >=，少一轮就不该跑");
    assert.equal(h.flushCalls, 0);
  });
});

test("自上次 Dream 以来没有文件变更 → 不执行 Dream", async () => {
  await withHarness({ autoIndexIntervalMinutes: 30, autoDreamIntervalMinutes: 1 }, async (h) => {
    captureTurns(h.service, 1, 24 * 60);
    const result = await h.service.runDueScheduledMaintenance();
    assert.equal(result.indexRan, true, "前置条件：本轮确实跑了索引");
    assert.equal(
      result.dreamRan,
      false,
      "Dream 是重写全局画像的破坏性操作，没有新的文件记忆就绝不能跑空转。",
    );
    assert.equal(h.dreamCalls, 0);
  });
});

test("reason 前缀不影响门控判定", async () => {
  await withHarness({ autoIndexIntervalMinutes: 30, autoDreamIntervalMinutes: 60 }, async (h) => {
    captureTurns(h.service, 1, 31);
    const result = await h.service.runDueScheduledMaintenance("turn_end");
    assert.equal(result.indexRan, true);
  });
});

// ========== Task 10: immediate 模式测试 ==========

test("maintenanceMode: immediate 下单轮对话后立即执行索引", async () => {
  await withHarness(
    { autoIndexIntervalMinutes: 30, autoDreamIntervalMinutes: 60, maintenanceMode: "immediate" },
    async (h) => {
      // 投喂一轮对话，时间戳是「刚刚」（1 分钟前），interval 模式下不满足时间条件
      captureTurns(h.service, 1, 1);
      const result = await h.service.runDueScheduledMaintenance();
      assert.equal(
        result.indexRan,
        true,
        "immediate 模式下只要有待索引内容就应该立即执行，不受时间间隔限制",
      );
      assert.equal(h.flushCalls, 1);
    },
  );
});

test("maintenanceMode: interval 下单轮对话且时间未到不执行索引", async () => {
  await withHarness(
    { autoIndexIntervalMinutes: 30, autoDreamIntervalMinutes: 60, maintenanceMode: "interval" },
    async (h) => {
      captureTurns(h.service, 1, 1);
      const result = await h.service.runDueScheduledMaintenance();
      assert.equal(
        result.indexRan,
        false,
        "interval 模式下时间未到应该不执行索引",
      );
      assert.equal(h.flushCalls, 0);
    },
  );
});

test("maintenanceMode: manual 下即使有大量待索引内容也不执行", async () => {
  await withHarness(
    { autoIndexIntervalMinutes: 30, autoDreamIntervalMinutes: 60, maintenanceMode: "manual" },
    async (h) => {
      // 投喂大量陈旧内容，interval 模式下肯定会触发
      captureTurns(h.service, BACKLOG_THRESHOLD + 10, 24 * 60);
      const result = await h.service.runDueScheduledMaintenance();
      assert.equal(
        result.indexRan,
        false,
        "manual 模式下定时维护完全不应该执行索引",
      );
      assert.equal(h.flushCalls, 0);
    },
  );
});

test("maintenanceMode: immediate 且 intervalMinutes = 0 时仍执行", async () => {
  await withHarness(
    { autoIndexIntervalMinutes: 0, autoDreamIntervalMinutes: 0, maintenanceMode: "immediate" },
    async (h) => {
      captureTurns(h.service, 1, 1);
      const result = await h.service.runDueScheduledMaintenance();
      assert.equal(
        result.indexRan,
        true,
        "immediate 模式应该绕过 intervalMinutes = 0 的「关闭」语义",
      );
      assert.equal(h.flushCalls, 1);
    },
  );
});

test("readPresentationMemory 确定性读取全局画像和当前项目 Feedback", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "ec-presentation-root-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "ec-presentation-workspace-"));
  const service = new EdgeClawMemoryService({ workspaceDir, rootDir });

  try {
    service.repository.getGlobalUserStore().upsertUserProfile({
      type: "user",
      scope: "global",
      name: "user-profile",
      description: "全局用户画像",
      body: [
        "## 身份背景",
        "- 急诊外科医师",
        "",
        "## 专业领域",
        "- 战创伤复苏",
        "",
        "## 临床偏好",
        "- 回答保持简洁",
      ].join("\n"),
    });
    service.repository.getFileMemoryStore().upsertCandidate({
      type: "feedback",
      scope: "project",
      name: "presentation-rule",
      description: "输出偏好",
      rule: "先给结论",
      howToApply: "使用编号列表",
    });
    service.repository.getFileMemoryStore().upsertCandidate({
      type: "project",
      scope: "project",
      name: "patient-state",
      description: "病例事实",
      summary: "患者收缩压 80mmHg，左下肢开放性骨折",
    });

    const memory = service.readPresentationMemory();
    assert.match(memory.globalProfile ?? "", /急诊外科医师/u);
    assert.match(memory.globalProfile ?? "", /战创伤复苏/u);
    assert.doesNotMatch(memory.globalProfile ?? "", /回答保持简洁|临床偏好/u);
    assert.match(memory.projectFeedback ?? "", /先给结论/u);
    assert.match(memory.projectFeedback ?? "", /使用编号列表/u);
    assert.doesNotMatch(memory.projectFeedback ?? "", /80mmHg|开放性骨折/u);
  } finally {
    service.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("readPresentationMemory 按更新时间取最新 Feedback 并排除 deprecated", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "ec-presentation-limit-root-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "ec-presentation-limit-workspace-"));
  const service = new EdgeClawMemoryService({ workspaceDir, rootDir });

  try {
    const store = service.repository.getFileMemoryStore();
    const older = store.upsertCandidate({
      type: "feedback",
      scope: "project",
      name: "older-rule",
      description: "旧偏好",
      rule: "旧规则",
    });
    const deprecated = store.upsertCandidate({
      type: "feedback",
      scope: "project",
      name: "deprecated-rule",
      description: "废弃偏好",
      rule: "废弃规则",
    });
    store.markEntriesDeprecated([deprecated.relativePath]);
    store.upsertCandidate({
      type: "feedback",
      scope: "project",
      name: "newer-rule",
      description: "新偏好",
      rule: "新规则",
    });

    const memory = service.readPresentationMemory({ feedbackLimit: 1 });
    assert.match(memory.projectFeedback ?? "", /新规则/u);
    assert.doesNotMatch(memory.projectFeedback ?? "", /旧规则|废弃规则/u);
    assert.ok(older.relativePath);
  } finally {
    service.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("并发 Dream 时全局画像写锁确保数据完整性", async () => {
  // 创建两个共享同一 rootDir 的 service 实例，模拟两个项目
  const sharedRoot = mkdtempSync(join(tmpdir(), "ec-concurrent-"));
  const projectA = mkdtempSync(join(tmpdir(), "project-a-"));
  const projectB = mkdtempSync(join(tmpdir(), "project-b-"));

  try {
    const serviceA = new EdgeClawMemoryService({
      workspaceDir: projectA,
      rootDir: sharedRoot,
    });
    const serviceB = new EdgeClawMemoryService({
      workspaceDir: projectB,
      rootDir: sharedRoot,
    });

    // 包装 dream 方法，在获取锁后、执行 Dream 期间人工延长持有时间
    const originalDreamA = serviceA.dream.bind(serviceA);
    let lockAcquiredA = false;
    serviceA.dream = async (trigger = "manual") => {
      // 先调用原始 Dream 开始获取锁
      const resultPromise = originalDreamA(trigger);
      // 如果成功获取锁，延长持有时间以确保与 B 的并发冲突
      if (serviceA["globalProfileLock"]["acquired"]) {
        lockAcquiredA = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return resultPromise;
    };

    let lockConflictB = false;
    const originalDreamB = serviceB.dream.bind(serviceB);
    serviceB.dream = async (trigger = "manual") => {
      const result = await originalDreamB(trigger);
      if (result.status === "skipped" && result.skipReason === "global_profile_locked") {
        lockConflictB = true;
      }
      return result;
    };

    // 并发触发两个 Dream
    const [resultA, resultB] = await Promise.all([
      serviceA.dream("manual"),
      serviceB.dream("manual"),
    ]);

    // 验证：A 应该成功并持有锁一段时间，B 应该因为锁冲突而 skip
    assert.ok(
      lockAcquiredA,
      "serviceA 应该成功获取锁",
    );
    assert.equal(
      resultB.status,
      "skipped",
      "serviceB 应该因为无法获取全局锁而被 skip",
    );
    assert.ok(lockConflictB, "应该记录锁冲突原因");

    serviceA.close();
    serviceB.close();
  } finally {
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
    rmSync(sharedRoot, { recursive: true, force: true });
  }
});
