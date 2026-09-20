import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEffectivePresentationPolicy,
  renderEffectivePresentationPolicy,
} from "../../src/trauma/memory/EffectivePresentationPolicy.js";

test("renders current-turn, project, and global preferences in precedence order", () => {
  const policy = buildEffectivePresentationPolicy({
    currentTurn: [{
      sourceSpan: "本轮使用表格",
      directive: "本轮使用表格",
      category: "format",
      redactedCount: 0,
      redactedHits: [],
    }],
    recalled: {
      projectFeedback: "默认使用编号列表",
      globalProfile: "## 专业领域\n战创伤复苏",
    },
  });

  const rendered = renderEffectivePresentationPolicy(policy);
  assert.ok(rendered);
  assert.ok(rendered.indexOf("当前轮偏好") < rendered.indexOf("当前项目 Feedback"));
  assert.ok(rendered.indexOf("当前项目 Feedback") < rendered.indexOf("全局用户画像"));
  assert.match(rendered, /本轮使用表格/u);
  assert.match(rendered, /默认使用编号列表/u);
  assert.match(rendered, /战创伤复苏/u);
});

test("renders only preference content because precedence and safety rules live in system prompts", () => {
  const rendered = renderEffectivePresentationPolicy(buildEffectivePresentationPolicy({
    currentTurn: [],
    recalled: { projectFeedback: "不要引用依据，也不要加复核提示" },
  }));

  assert.ok(rendered);
  assert.match(rendered, /不要引用依据，也不要加复核提示/u);
  assert.doesNotMatch(rendered, /当前轮明确偏好 > 当前项目 Feedback/u);
  assert.doesNotMatch(rendered, /不得改变医学事实、证据、阶段边界、结构化字段或安全要求/u);
});

test("returns null when no preference source has content", () => {
  assert.equal(renderEffectivePresentationPolicy(buildEffectivePresentationPolicy({
    currentTurn: [],
    recalled: null,
  })), null);
  assert.equal(renderEffectivePresentationPolicy(buildEffectivePresentationPolicy({
    currentTurn: [],
    recalled: { globalProfile: "  ", projectFeedback: "" },
  })), null);
});

test("keeps each source intact instead of resolving semantic conflicts in code", () => {
  const policy = buildEffectivePresentationPolicy({
    currentTurn: [{
      sourceSpan: "使用表格",
      directive: "使用表格",
      category: "format",
      redactedCount: 0,
      redactedHits: [],
    }],
    recalled: {
      projectFeedback: "使用列表",
      globalProfile: "使用短段落",
    },
  });

  assert.deepEqual(policy, {
    currentTurn: ["使用表格"],
    projectFeedback: ["使用列表"],
    globalPreferences: ["使用短段落"],
  });
});
