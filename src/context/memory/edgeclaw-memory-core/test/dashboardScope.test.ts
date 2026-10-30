/**
 * Task 8 —— Dashboard 作用域身份。
 *
 * 运行：npm test（子包内），或 `pnpm exec tsx --test test/dashboardScope.test.ts`
 *
 * 为什么放在子包测试里而不是 `MemoryPanel.test.tsx`：面板侧只负责拼 iframe URL，
 * URL **被消费之后**的行为全在 `ui-source/` 里。app.js 是一整个 DOM 应用，
 * 所以这段寻址逻辑被抽成 `dashboard-scope.js`，在这里直接覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  hasAddressableScope,
  readDashboardScope,
  withScope,
  withScopeBody,
  type DashboardScope,
} from "../ui-source/dashboard-scope.js";

function scope(overrides: Partial<DashboardScope> = {}): DashboardScope {
  return {
    projectId: "trauma_med-abc123",
    projectType: "war_trauma",
    sessionId: "web:s1",
    projectPath: "/home/u/.pilotdeck/workspaces/trauma_med/trauma_med-abc123",
    ...overrides,
  };
}

test("从查询参数读出完整作用域", () => {
  const params = new URLSearchParams({
    projectId: "trauma_med-abc123",
    projectType: "war_trauma",
    sessionId: "web:s1",
    projectPath: "/tmp/ws",
    locale: "zh",
  });
  assert.deepEqual(readDashboardScope(params), {
    projectId: "trauma_med-abc123",
    projectType: "war_trauma",
    sessionId: "web:s1",
    projectPath: "/tmp/ws",
  });
});

test("缺失参数归一化为空串，不是 null/undefined", () => {
  assert.deepEqual(readDashboardScope(new URLSearchParams()), {
    projectId: "",
    projectType: "",
    sessionId: "",
    projectPath: "",
  });
});

test("参数两侧空白被裁掉", () => {
  const params = new URLSearchParams({ projectId: "  trauma_med-abc123  " });
  assert.equal(readDashboardScope(params).projectId, "trauma_med-abc123");
});

test("只有 projectId 才算可寻址——projectPath 不能顶替", () => {
  assert.equal(hasAddressableScope(scope()), true);
  assert.equal(
    hasAddressableScope(scope({ projectId: "" })),
    false,
    "没有稳定 id 时必须判为不可寻址，不能回落到 projectPath",
  );
  assert.equal(hasAddressableScope(null), false);
});

test("withScope 把 projectId 作为寻址键写进查询串", () => {
  const url = withScope("/api/memory/workspace", scope());
  assert.match(url, /^\/api\/memory\/workspace\?/u);
  const query = new URLSearchParams(url.split("?")[1]);
  assert.equal(query.get("projectId"), "trauma_med-abc123");
  assert.equal(query.get("projectType"), "war_trauma");
  assert.equal(query.get("sessionId"), "web:s1");
  assert.equal(
    query.get("projectPath"),
    "/home/u/.pilotdeck/workspaces/trauma_med/trauma_med-abc123",
  );
});

test("withScope 保留原有查询参数", () => {
  const query = new URLSearchParams(withScope("/api/memory/cases?limit=12", scope()).split("?")[1]);
  assert.equal(query.get("limit"), "12");
  assert.equal(query.get("projectId"), "trauma_med-abc123");
});

test("withScope 不写入空字段", () => {
  const url = withScope("/api/memory/workspace", scope({ sessionId: "", projectPath: "" }));
  const query = new URLSearchParams(url.split("?")[1]);
  assert.equal(query.has("sessionId"), false);
  assert.equal(query.has("projectPath"), false);
});

test("写请求 body 始终带上 projectId", () => {
  const body = withScopeBody({ status: "in_progress" }, scope());
  assert.deepEqual(body, {
    status: "in_progress",
    projectId: "trauma_med-abc123",
    projectPath: "/home/u/.pilotdeck/workspaces/trauma_med/trauma_med-abc123",
  });
});

test("写请求 body 在作用域缺 projectId 时给空串——让服务端拒绝，而不是本地静默通过", () => {
  const body = withScopeBody({}, scope({ projectId: "" }));
  assert.equal(body.projectId, "");
});
