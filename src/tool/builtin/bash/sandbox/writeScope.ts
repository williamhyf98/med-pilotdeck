import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * 沙箱可写范围的唯一计算口径（`docs/plans/sandbox-write-scope-narrowing.md`）。
 *
 * 为什么单独一个纯函数：bwrap 的 argv、sandbox-exec 的 profile、启动自检的
 * `grants()` 三处必须给出**完全一致**的可写集合，否则会出现"profile 说能写、
 * 实际挂载不能写"这种最难查的故障。
 *
 * 两种档位：
 * - `narrowWrites: false`（默认，兼容旧行为）→ 整个用户 home 可写；
 * - `narrowWrites: true` → 调用方给的工作区 + `<home>/.cache` + `<home>/.tmp`。
 */
export type WriteScopeInput = {
  userHome: string;
  /** 调用方声明的可写根（通常是 agent 的工作区目录）。 */
  writeRoots?: readonly string[];
  narrowWrites: boolean;
};

/** 路径的规范化形式：绝对化 + 能 realpath 就 realpath（macOS 的 /var ↔ /private/var）。 */
export function canonicalPath(input: string): string {
  const absolute = resolve(input);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * 计算真正可写的绝对路径列表。
 *
 * 硬规则：
 * - 永远不会返回 home 本身（除非 `narrowWrites: false`）；
 * - 拒绝相对路径、拒绝 `..` 逃逸、拒绝 home 之外的根；
 * - `.cache` / `.tmp` 由沙箱负责创建，不依赖它们在磁盘上已存在。
 */
export function resolveWriteRoots(input: WriteScopeInput): string[] {
  const rawHome = resolve(input.userHome);
  const home = canonicalPath(input.userHome);
  // 兼容档位：返回**原始拼写**。调用方再用 pathForms/grantForms 补上 realpath，
  // 这样 symlink 形式的 home 会同时出现在授权里（既有行为，勿改）。
  if (!input.narrowWrites) return [rawHome];

  const roots: string[] = [];
  /** 每个逻辑根都登记"原始拼写 + realpath"两种形式：bwrap 按原始路径挂载，
   *  sandbox-exec 的 SBPL 也按原始路径匹配，只给一种会在 symlink 场景下失效。 */
  const push = (absolute: string, canonical: string = canonicalPath(absolute)): void => {
    for (const form of [absolute, canonical]) {
      if (!roots.includes(form)) roots.push(form);
    }
  };

  for (const raw of input.writeRoots ?? []) {
    if (typeof raw !== "string" || !raw.trim() || !isAbsolute(raw)) continue;
    const dir = canonicalPath(raw);
    // 工作区必须真的在 home 内；home 本身不单独放行（会把整包写回来）。
    if (dir === home || !isWithin(dir, home)) continue;
    push(resolve(raw));
  }

  // .cache / .tmp 可能还没建，realpath 会失败；用「canonical(home) + 子目录名」
  // 直接推导，保证两种拼写都登记上（否则 symlink 的 home 只有一种拼写可写）。
  push(join(rawHome, ".cache"), join(home, ".cache"));
  push(join(rawHome, ".tmp"), join(home, ".tmp"));
  return roots;
}

/** 日志/审计用的简短描述，避免把完整路径写进普通日志。 */
export function describeWriteScope(narrowWrites: boolean): string {
  return narrowWrites ? "narrow" : "home";
}
