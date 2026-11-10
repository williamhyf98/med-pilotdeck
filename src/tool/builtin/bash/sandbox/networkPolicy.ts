import type { SandboxNetworkMode } from "../../../../pilot/config/types.js";

/**
 * 按命令判定网络出口（spec §10.5）。
 *
 * 判定顺序：
 * 1. 命令里出现的 `…/skills/<name>/` 全部在 `networkOpenSkills` 白名单内 → `open`
 * 2. 其它一切（含没有 skill、只部分命中、不认识的新 skill）→ 全局 `network` 值
 *
 * 默认方向永远是「收紧」：白名单只做加法，任何不确定都落回全局策略。
 */

export type CommandNetworkDecision = {
  allowNetwork: boolean;
  policy: SandboxNetworkMode;
  skills: string[];
  reason: string;
};

/**
 * 只匹配真正的路径段 `skills/<name>/`，前面必须是行首或分隔符。
 * 这样 `foo/myskills/docx/` 不会被误判为 docx 技能（否则等于开了提权口子）。
 */
const SKILL_PATH_RE = /(?:^|[/\s"'=[(:;|&,])skills\/([A-Za-z0-9._-]+)\//gu;

export function extractSkillNames(command: string): string[] {
  const names = new Set<string>();
  for (const match of String(command ?? "").matchAll(SKILL_PATH_RE)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

export function resolveCommandNetworkPolicy(
  command: string,
  defaultPolicy: SandboxNetworkMode,
  openSkills: readonly string[],
): CommandNetworkDecision {
  const skills = extractSkillNames(command);
  if (skills.length === 0) {
    return {
      allowNetwork: defaultPolicy !== "none",
      policy: defaultPolicy,
      skills,
      reason: "命令未引用任何 skill，按全局策略",
    };
  }
  const allowed = new Set(openSkills);
  const blocked = skills.filter((name) => !allowed.has(name));
  if (blocked.length === 0) {
    return {
      allowNetwork: true,
      policy: "open",
      skills,
      reason: `skill ${skills.join(", ")} 在 networkOpenSkills 白名单内`,
    };
  }
  return {
    allowNetwork: defaultPolicy !== "none",
    policy: defaultPolicy,
    skills,
    reason: `skill ${blocked.join(", ")} 不在白名单内，按全局策略`,
  };
}

/** `allowlist` 目前尚未实现，配了就启动报错，绝不静默降级为 `open`。 */
export function assertNetworkPolicySupported(
  policy: SandboxNetworkMode,
  platform: NodeJS.Platform,
): void {
  if (policy !== "allowlist") return;
  throw new Error(
    `multiUser.sandbox.network=allowlist 尚未实现（平台 ${platform}）。` +
      "请改用 none 或 open；端口级白名单见 docs/permission-arch-v2-design.zh.md §10.5。",
  );
}
