import type { SandboxNetworkMode } from "../../../../pilot/config/types.js";
import { tokenizeSimpleShell } from "../permissions.js";

/**
 * 按命令判定网络出口（spec §10.5）。
 *
 * 判定顺序：
 * 1. 命令必须是**单条简单命令**（不含 `| ; & < > \`` `$(`），否则一律落回全局策略
 * 2. 命令里出现的 `…/skills/<name>/` 全部在 `networkOpenSkills` 白名单内 → `open`
 * 3. 其它一切（含没有 skill、只部分命中、不认识的新 skill）→ 全局 `network` 值
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

/** 允许的前缀：`cd <path> &&`（最多 3 层），模型经常这样进目录。 */
const CD_PREFIX_RE = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|<>]+)\s*&&\s*(?=\S)/u;

/**
 * 是否是一条「不带 shell 组合」的简单命令。
 *
 * 为什么必须卡这一条：`bash skills/docx/docx.sh make && python3 evil.py` 里
 * 只有 docx 一个技能名，若只按技能名判定就会把整条复合命令都放行 —— 等于给
 * 任意代码开了出口。
 */
export function isSingleSimpleInvocation(command: string): boolean {
  return simpleInvocationTokens(command) !== undefined;
}

/**
 * 去掉最多 3 层 `cd <path> &&` 前缀后做单命令分词；含管道/串联/重定向时返回 undefined。
 * 命令白名单（security/policy/registeredCommands.ts）复用同一个分词口径，
 * 保证"能不能出网"和"能不能免弹窗"不会对同一条命令给出互相矛盾的结论。
 */
export function simpleInvocationTokens(command: string): string[] | undefined {
  let rest = String(command ?? "").trim();
  for (let index = 0; index < 3; index += 1) {
    const prefix = rest.match(CD_PREFIX_RE);
    if (!prefix) break;
    rest = rest.slice(prefix[0].length).trim();
  }
  if (!rest) return undefined;
  const tokens = tokenizeSimpleShell(rest);
  return tokens && tokens.length > 0 ? tokens : undefined;
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
    if (!isSingleSimpleInvocation(command)) {
      return {
        allowNetwork: defaultPolicy !== "none",
        policy: defaultPolicy,
        skills,
        reason: "命令不是单条简单命令（含管道/串联/重定向），不放行网络",
      };
    }
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

/**
 * `allowlist` 只有 macOS（sandbox-exec）实现，且只支持端口级（SBPL 的 `remote ip`
 * 不接受数字 IP，2026-11-11 实测）。其它平台或不给端口一律启动报错，
 * 绝不静默降级为 `open`。
 */
export function assertNetworkPolicySupported(
  policy: SandboxNetworkMode,
  platform: NodeJS.Platform,
  allow: readonly { host: string; port: number }[] = [],
): void {
  if (policy !== "allowlist") return;
  if (platform === "darwin") {
    if (allow.length === 0) {
      throw new Error(
        "multiUser.sandbox.network=allowlist 需要 networkAllow 至少一项（macOS 只支持端口级白名单）。" +
          "缺少端口会让 office 类技能直接不可用。",
      );
    }
    return;
  }
  throw new Error(
    `multiUser.sandbox.network=allowlist 仅 macOS 支持（当前平台 ${platform}）。` +
      "Linux 的 --unshare-net 是二元的，请改用 none 或 open；见 docs/permission-arch-v2-design.zh.md §10.5。",
  );
}
