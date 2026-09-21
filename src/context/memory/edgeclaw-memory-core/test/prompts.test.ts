/**
 * 提示词结构快照 —— Task 5「提示词档案机制」的搬运正确性判据。
 *
 * 为什么用哈希而不是全文断言：
 *   Task 5 会把这些常量搬进 `core/skills/prompts/generalMedicine.ts`，由
 *   `llm-extraction.ts` re-export。只要本文件的 import 路径不变，搬运后哈希
 *   仍然相等，就证明「纯机制重构、通用医学行为零变化」这一约束成立。
 *   全文断言会让本文件在搬运时被迫重写，反而证明不了任何东西。
 *
 * 哈希失配 = 提示词内容被改动了。这不一定是错误：
 *   - Task 4 会改 USER_PROFILE_REWRITE_SYSTEM_PROMPT（全局画像三段化）
 *   - 提示词中文化会在保持语义和协议不变的前提下更新全部快照
 *   这些任务里更新下面的 expected 值是**预期动作**；但在 Task 5 里更新它，
 *   说明搬运不忠实，必须回退重来。
 *
 * 刻意不覆盖 EXTRACTION_SYSTEM_PROMPT —— 它是死代码（方案 §1.3），
 * 全仓库零引用，Task 12 会删除。给死代码建快照只会制造虚假的改动阻力。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT,
  MEMORY_CLASSIFICATION_SYSTEM_PROMPT,
  PROJECT_NOTE_CREATE_SYSTEM_PROMPT,
  USER_NOTE_CREATE_SYSTEM_PROMPT,
  USER_PROFILE_REWRITE_SYSTEM_PROMPT,
} from "../src/core/skills/llm-extraction.ts";

interface PromptSnapshot {
  readonly name: string;
  readonly prompt: string;
  /** sha256 前 16 位，足以锁定内容且便于人工比对 */
  readonly sha256: string;
  readonly length: number;
  readonly lines: number;
  /** 改这条提示词的任务；在别的任务里看到它失配就要停下来 */
  readonly ownedBy: string;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

const SNAPSHOTS: readonly PromptSnapshot[] = [
  {
    name: "MEMORY_CLASSIFICATION_SYSTEM_PROMPT",
    prompt: MEMORY_CLASSIFICATION_SYSTEM_PROMPT,
    sha256: "2f78e9a3af9fff86",
    length: 1446,
    lines: 31,
    ownedBy: "Task 11 通用医学提取",
  },
  {
    name: "USER_NOTE_CREATE_SYSTEM_PROMPT",
    prompt: USER_NOTE_CREATE_SYSTEM_PROMPT,
    sha256: "c52a5359d0c68df3",
    length: 886,
    lines: 23,
    ownedBy: "Index/Dream 提示词中文化",
  },
  {
    name: "PROJECT_NOTE_CREATE_SYSTEM_PROMPT",
    prompt: PROJECT_NOTE_CREATE_SYSTEM_PROMPT,
    sha256: "d90870f6d962d683",
    length: 1053,
    lines: 25,
    ownedBy: "Index/Dream 提示词中文化",
  },
  {
    name: "FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT",
    prompt: FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT,
    sha256: "e39fb08a3fb51cbc",
    length: 1153,
    lines: 26,
    ownedBy: "Index/Dream 提示词中文化",
  },
  {
    name: "USER_PROFILE_REWRITE_SYSTEM_PROMPT",
    prompt: USER_PROFILE_REWRITE_SYSTEM_PROMPT,
    sha256: "cfe8c80ed66bb353",
    length: 708,
    lines: 22,
    ownedBy: "Index/Dream 提示词中文化",
  },
];

for (const snapshot of SNAPSHOTS) {
  test(`提示词内容未漂移：${snapshot.name}`, () => {
    const actual = digest(snapshot.prompt);
    assert.equal(
      actual,
      snapshot.sha256,
      [
        `${snapshot.name} 的内容与快照不符。`,
        `  期望 sha256: ${snapshot.sha256}`,
        `  实际 sha256: ${actual}（长度 ${snapshot.prompt.length}，${snapshot.prompt.split("\n").length} 行）`,
        `  这条提示词归属：${snapshot.ownedBy}`,
        "",
        "  如果你正在执行该任务，更新本文件的 sha256/length/lines 即可。",
        "  如果你正在执行 Task 5（提示词档案机制），这是搬运不忠实的信号——",
        "  Task 5 必须是纯机制重构，一个字都不能改，请回退后重新搬运。",
      ].join("\n"),
    );
    assert.equal(snapshot.prompt.length, snapshot.length, `${snapshot.name} 长度变化`);
    assert.equal(
      snapshot.prompt.split("\n").length,
      snapshot.lines,
      `${snapshot.name} 行数变化`,
    );
  });
}

test("五个活提示词都非空且互不相同", () => {
  const seen = new Map<string, string>();
  for (const { name, prompt } of SNAPSHOTS) {
    assert.ok(prompt.trim().length > 0, `${name} 不应为空`);
    const key = digest(prompt);
    const duplicate = seen.get(key);
    assert.equal(
      duplicate,
      undefined,
      `${name} 与 ${duplicate} 内容完全相同——多半是 Task 5 搬运时复制粘贴错了档案`,
    );
    seen.set(key, name);
  }
});
