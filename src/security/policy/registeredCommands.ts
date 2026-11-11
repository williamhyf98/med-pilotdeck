import path from "node:path";
import type { CommandPolicy, CommandRule, TaskReadRoot, TaskWriteRoot } from "./parseCommandPolicy.js";
import { DOCUMENT_COMMAND_SPECS, type DocumentOptionKind } from "./documentCommandSpecs.js";
import { SKILL_COMMAND_SPECS } from "./skillCommandSpecs.js";

/**
 * 注册命令匹配器（spec §10.4.1）。
 *
 * 只做一件事：判断一条 shell 命令是不是**某条已登记命令的合规调用**。
 * 命中且合规 → 交给调用方放行（零弹窗）；其余一律"不表态"，由调用方回落 ask/只读判定。
 *
 * 刻意保守：
 * - 只认 `skills/<skill>/scripts/<file>.sh <subcommand>` 这一种形状，其余一律不认；
 * - 选项必须逐字命中白名单，**不支持等号写法**（`--out=x` 视为未登记，回落 ask）；
 * - 路径型选项的值必须落在登记的读写根内，且不允许 `..` 逃逸。
 */

const SCRIPT_RE = /^(?:.*\/)?skills\/([A-Za-z0-9._-]+)\/scripts\/[A-Za-z0-9._-]+\.sh$/u;
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]*$/u;
const SHELLS = new Set(["bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"]);

const OPTION_KINDS: Readonly<Record<string, Readonly<Record<string, DocumentOptionKind>>>> = Object.freeze({
  ...DOCUMENT_COMMAND_SPECS,
  ...SKILL_COMMAND_SPECS,
});

export type RegisteredInvocation = Readonly<{
  id: string;
  skill: string;
  subcommand: string;
  args: readonly string[];
}>;

/** 从 tokens 里认出 `<...>/skills/<skill>/scripts/x.sh <subcommand> ...`；认不出返回 undefined。 */
export function detectRegisteredInvocation(tokens: readonly string[]): RegisteredInvocation | undefined {
  if (!Array.isArray(tokens) || tokens.length < 2) return undefined;
  let index = 0;
  if (SHELLS.has(tokens[index]!)) index += 1;
  const script = tokens[index];
  if (!script) return undefined;
  const match = SCRIPT_RE.exec(script);
  if (!match) return undefined;
  const skill = match[1]!;
  const subcommand = tokens[index + 1];
  if (!subcommand || !SUBCOMMAND_RE.test(subcommand)) return undefined;
  return { id: `${skill}.${subcommand}`, skill, subcommand, args: tokens.slice(index + 2) };
}

export type RegisteredCommandResult =
  | { kind: "allow"; rule: CommandRule }
  /** 已登记的 id，但调用违反了自己的规则；`security` 为真表示越根（写 inbox 等） */
  | { kind: "violation"; rule: CommandRule; reason: string; security: boolean }
  /** 不是登记范围内的命令（未登记 id / 形状不对） */
  | { kind: "unregistered"; id?: string; reason: string };

export function evaluateRegisteredCommand(
  tokens: readonly string[],
  options: { policy: CommandPolicy; cwd: string },
): RegisteredCommandResult {
  const invocation = detectRegisteredInvocation(tokens);
  if (!invocation) return { kind: "unregistered", reason: "shape" };

  const rule = options.policy.commands.find((entry) => entry.id === invocation.id);
  if (!rule) return { kind: "unregistered", id: invocation.id, reason: "not-registered" };
  if (!rule.enabled) return { kind: "unregistered", id: invocation.id, reason: "disabled" };

  const kinds = OPTION_KINDS[invocation.id];
  if (!kinds) return { kind: "unregistered", id: invocation.id, reason: "no-spec" };

  const args = invocation.args;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      return { kind: "violation", rule, reason: `unexpected positional argument: ${clip(token)}`, security: false };
    }
    const kind = kinds[token];
    if (!kind || !rule.allowedOptions.includes(token)) {
      return { kind: "violation", rule, reason: `option not registered: ${clip(token)}`, security: false };
    }
    if (kind === "switch") continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { kind: "violation", rule, reason: `option ${clip(token)} requires a value`, security: false };
    }
    index += 1;
    if (kind === "number") {
      if (!/^\d{1,9}$/u.test(value)) {
        return { kind: "violation", rule, reason: `option ${clip(token)} expects a number`, security: false };
      }
      continue;
    }
    if (kind === "input" || kind === "inputs" || kind === "output") {
      const check = checkRoot(value, kind === "output" ? rule.outputRoots : rule.inputRoots, options.cwd);
      if (!check.ok) {
        return {
          kind: "violation",
          rule,
          reason: `option ${clip(token)} points outside its allowed roots (${check.reason})`,
          security: true,
        };
      }
    }
  }

  return { kind: "allow", rule };
}

function checkRoot(
  value: string,
  roots: readonly (TaskReadRoot | TaskWriteRoot)[],
  cwd: string,
): { ok: true } | { ok: false; reason: string } {
  if (!value || value.includes("\0")) return { ok: false, reason: "empty" };
  if (roots.length === 0) return { ok: false, reason: "no roots registered" };
  const absolute = path.resolve(cwd, value);
  const relative = path.relative(path.resolve(cwd), absolute);
  if (!relative || relative === "") return { ok: false, reason: "workspace root itself" };
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reason: "escapes the workspace" };
  const first = relative.split(path.sep)[0]!;
  if (!roots.includes(first as TaskReadRoot | TaskWriteRoot)) {
    return { ok: false, reason: `"${first}" is not in ${roots.join("|")}` };
  }
  return { ok: true };
}

function clip(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 60)}…`;
}
