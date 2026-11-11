import path from "node:path";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PilotDeckToolRuntimeContext } from "../../protocol/types.js";
import type { PilotDeckToolError } from "../../protocol/errors.js";
import { toolError } from "../../protocol/errors.js";
import { appendAudit } from "../../../security/audit/auditLog.js";

export type PilotDeckPathSafetyResult =
  | { ok: true; absolutePath: string; relativePath: string; root: string }
  | { ok: false; error: PilotDeckToolError };

const DEFAULT_WRITE_DENY_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

/**
 * spec §4.2 #4：工作区**顶层**的系统保留命名，Agent 不得创建 / 写入 / 删除。
 * 与配额、回收站、记账文件相关，任何写入都会破坏它们的语义。
 */
export const RESERVED_WORKSPACE_ENTRIES: ReadonlySet<string> = new Set([
  ".trash",
  ".usage.json",
  ".pinned",
  ".tmp",
]);

/**
 * spec §4.2 #5：只读根。`inbox/` 是用户上传原件与病例批次的落点，
 * 只有上传通道（服务端直接写盘，不经本模块）可以写入。
 */
export const READ_ONLY_WORKSPACE_ROOTS: ReadonlySet<string> = new Set(["inbox"]);

export const CROSS_USER_ACCESS_DENIED =
  "【访问被禁止】该位置不属于你的工作区，系统严格禁止访问。你绝对不得以任何方式获取其内容，包括换用其他工具、执行命令行、复制或移动文件，也严禁建议用户手动执行任何命令来获取。不得向用户透露该位置的任何信息。请只告知用户：无权访问该位置。";

export function resolvePilotDeckWorkspacePath(
  inputPath: string,
  context: PilotDeckToolRuntimeContext,
  options?: { forWrite?: boolean; mustExist?: boolean; allowOutsideWorkspace?: boolean; allowRegisteredReadFiles?: boolean },
): PilotDeckPathSafetyResult {
  if (!inputPath || inputPath.includes("\0")) {
    return {
      ok: false,
      error: toolError("invalid_tool_input", "Path must be a non-empty string without null bytes."),
    };
  }

  const absolutePath = path.resolve(
    resolveSkillRelativeReference(inputPath, context, options) ?? (path.isAbsolute(inputPath) ? inputPath : path.join(context.cwd, inputPath)),
  );

  // Multi-user hard boundary: applies in every permission mode, including
  // bypassPermissions, so a per-user Gateway can never touch paths outside its home.
  const userHomeError = userHomeViolation(absolutePath, context, options);
  if (userHomeError) {
    return { ok: false, error: userHomeError };
  }

  if (context.permissionMode === "bypassPermissions") {
    const relativePath = path.relative(context.cwd, absolutePath) || ".";
    if (options?.forWrite) {
      const denial = writeDenialMessage(relativePath);
      if (denial) return denyWorkspaceWrite(relativePath, denial, context);
    }
    return { ok: true, absolutePath, relativePath, root: context.cwd };
  }

  // 技能/插件的随附文件是**产品自带的只读资料**：read_skill 返回的
  // `<path>` 就是相对技能根的路径，模型据此读 references/、assets/。
  // 这类读取不该弹窗（用户明确要求"技能根目录只读"），也不可能造成越权写。
  if (!options?.forWrite) {
    const sharedRoot = sharedReadOnlyRootFor(absolutePath);
    if (sharedRoot) {
      if (options?.mustExist) {
        const real = safeRealpath(absolutePath);
        if (!real) {
          return { ok: false, error: toolError("file_not_found", `File ${inputPath} does not exist.`) };
        }
        const realRoot = safeRealpath(sharedRoot) ?? sharedRoot;
        if (!isPathWithinRoot(real, realRoot)) {
          return {
            ok: false,
            error: toolError("path_not_allowed", `Path ${inputPath} resolves outside the shared skill tree.`),
          };
        }
      }
      return {
        ok: true,
        absolutePath,
        relativePath: path.relative(sharedRoot, absolutePath) || ".",
        root: sharedRoot,
      };
    }
  }

  const roots = [context.cwd, ...context.permissionContext.additionalWorkingDirectories].map((root) =>
    path.resolve(root),
  );
  const root = roots.find((candidate) => isPathWithinRoot(absolutePath, candidate));

  if (!root) {
    if (!options?.forWrite && options?.allowRegisteredReadFiles) {
      const real = safeRealpath(absolutePath);
      if (!real) {
        return {
          ok: false,
          error: toolError("file_not_found", `File ${inputPath} does not exist.`),
        };
      }
      const allowed = (context.allowedReadFiles ?? []).some((allowedPath) => {
        const allowedReal = safeRealpath(allowedPath) ?? path.resolve(allowedPath);
        return real === allowedReal;
      });
      if (allowed || isManagedImAttachmentFile(real, context) || isManagedChatAttachmentFile(real, context)) {
        const relativePath = path.relative(context.cwd, absolutePath) || ".";
        return { ok: true, absolutePath, relativePath, root: context.cwd };
      }
    }

    if (options?.allowOutsideWorkspace) {
      const relativePath = path.relative(context.cwd, absolutePath) || ".";
      if (options?.forWrite) {
        const denial = writeDenialMessage(relativePath);
        if (denial) return denyWorkspaceWrite(relativePath, denial, context);
      }
      return { ok: true, absolutePath, relativePath, root: context.cwd };
    }

    return {
      ok: false,
      error: toolError("path_not_allowed", `Path ${inputPath} is outside the PilotDeck workspace.`),
    };
  }

  const relativePath = path.relative(root, absolutePath) || ".";
  if (options?.forWrite) {
    const denial = writeDenialMessage(relativePath);
    if (denial) return denyWorkspaceWrite(relativePath, denial, context);
  }

  if (options?.mustExist) {
    const real = safeRealpath(absolutePath);
    if (!real) {
      return {
        ok: false,
        error: toolError("file_not_found", `File ${inputPath} does not exist.`),
      };
    }

    const realRoot = safeRealpath(root) ?? root;
    if (!isPathWithinRoot(real, realRoot)) {
      return {
        ok: false,
        error: toolError("path_not_allowed", `Path ${inputPath} resolves outside the PilotDeck workspace.`),
      };
    }
  }

  return { ok: true, absolutePath, relativePath, root };
}

export function toWorkspaceRelativePath(absolutePath: string, root: string): string {
  return path.relative(root, absolutePath) || ".";
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * In multi-user mode (PILOTDECK_DISABLE_LOCAL_AUTH=0|false) every file tool
 * path must resolve, following symlinks, to somewhere inside PILOT_HOME (the
 * user home of the per-user Gateway). Returns a generic error that does not
 * echo the real root or the caller's path. Local single-user mode is unchanged.
 *
 * **Read-only whitelist**: For read operations (`forWrite` undefined/false), paths
 * under `<appRoot>/skills/` and `<appRoot>/plugins/` are allowed even though
 * they are outside PILOT_HOME, enabling Agent to access shared skill references.
 */
function userHomeViolation(
  absolutePath: string,
  context: PilotDeckToolRuntimeContext,
  options?: { forWrite?: boolean },
): PilotDeckToolError | undefined {
  const env = context.env ?? process.env;
  if (!isMultiUserLoginEnabled(env)) return undefined;
  const home = path.resolve(env.PILOT_HOME ?? path.join(homedir(), ".pilotdeck"));
  const realHome = resolveForContainment(home) ?? home;
  const realTarget = resolveForContainment(absolutePath);
  if (!realTarget || !isPathWithinRoot(realTarget, realHome)) {
    // For read operations in multi-user mode, allow access to shared resources:
    // - <appRoot>/skills/ (bundled and medical skills)
    // - <appRoot>/plugins/ (shared MCP plugins)
    if (!options?.forWrite && realTarget) {
      if (isUnderSharedReadOnlyRoot(realTarget)) {
        return undefined; // Allow read access to shared resources
      }
    }
    appendAudit(
      {
        action: "file.denied",
        decision: "deny",
        target: "(outside-workspace)",
        reason: "cross-user access denied",
        meta: { mode: context.permissionMode },
      },
      { env },
    );
    return toolError("path_not_allowed", CROSS_USER_ACCESS_DENIED);
  }
  return undefined;
}

/**
 * True when `target` (already realpath-resolved) lies under the shared, read-only
 * `<appRoot>/skills` or `<appRoot>/plugins` trees. Roots are realpath-resolved too,
 * so symlinked install locations compare correctly.
 */
function isUnderSharedReadOnlyRoot(target: string): boolean {
  const appRoot = resolveAppRootForWhitelist();
  if (!appRoot) return false;
  return ["skills", "plugins"].some((name) => {
    const root = path.join(appRoot, name);
    return isPathWithinRoot(target, safeRealpath(root) ?? root);
  });
}

/** 命中的共享只读根（`<appRoot>/skills` 或 `<appRoot>/plugins`），否则 undefined。 */
function sharedReadOnlyRootFor(target: string): string | undefined {
  const appRoot = resolveAppRootForWhitelist();
  if (!appRoot) return undefined;
  const real = safeRealpath(target) ?? target;
  for (const name of ["skills", "plugins"]) {
    const root = path.join(appRoot, name);
    const realRoot = safeRealpath(root) ?? root;
    if (isPathWithinRoot(real, realRoot)) return realRoot;
  }
  return undefined;
}

/**
 * SKILL.md 里写的是"相对该 SKILL.md 所在目录解析"，而 `read_skill` 返回的
 * `<path>` 形如 `docx/SKILL.md`。所以模型自然会写 `docx/references/x.md`，
 * 这不是工作区里的路径。这里把这种写法解析到真正的技能目录：
 * - 只对**相对路径**生效，且工作区里同名路径优先（不改变既有语义）
 * - 禁止 `..`，解析结果必须落在该技能目录内
 * - 只读操作才会走到这里（写操作不重写路径）
 */
function resolveSkillRelativeReference(
  inputPath: string,
  context: PilotDeckToolRuntimeContext,
  options?: { forWrite?: boolean },
): string | undefined {
  if (options?.forWrite || path.isAbsolute(inputPath)) return undefined;
  const segments = inputPath.split(/[\\/]/).filter((segment) => segment !== "");
  if (segments.length < 2) return undefined;
  const [first, ...rest] = segments;
  if (first === "." || first === ".." || rest.includes("..")) return undefined;
  // 工作区里真的存在这个相对路径时，保持原有行为。
  if (existsSync(path.join(context.cwd, ...segments))) return undefined;

  const appRoot = resolveAppRootForWhitelist();
  if (!appRoot) return undefined;
  const candidates = [
    path.join(appRoot, "skills", first),
    ...safeReaddir(path.join(appRoot, "plugins")).map((plugin) => path.join(appRoot, "plugins", plugin, "skills", first)),
  ];
  for (const skillDir of candidates) {
    const target = path.join(skillDir, ...rest);
    if (!existsSync(target)) continue;
    const realSkillDir = safeRealpath(skillDir) ?? skillDir;
    const realTarget = safeRealpath(target) ?? target;
    if (isPathWithinRoot(realTarget, realSkillDir)) return target;
  }
  return undefined;
}

function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Nearest ancestor of this module that contains package.json (works for src/ and dist/ layouts). */
function resolveAppRootForWhitelist(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isMultiUserLoginEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PILOTDECK_DISABLE_LOCAL_AUTH;
  return value === "0" || value === "false";
}

/**
 * Realpath of `target`, resolving the deepest existing ancestor and re-appending
 * the non-existent tail (so new files can be checked before they exist).
 * Returns undefined for a dangling symlink, which is treated as outside (fail closed).
 */
function resolveForContainment(target: string): string | undefined {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    const real = safeRealpath(current);
    if (real) return path.join(real, ...tail.reverse());
    if (isSymbolicLink(current)) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    tail.push(path.basename(current));
    current = parent;
  }
}

function isSymbolicLink(value: string): boolean {
  try {
    return lstatSync(value).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Write-denial reason for a workspace-relative path, or undefined when the write
 * is allowed. Only the **top-level** segment decides (spec §4.2 #4/#5/#7):
 * anything nested under a normal directory stays writable.
 */
function writeDenialMessage(relativePath: string): string | undefined {
  const firstPart = relativePath.split(path.sep)[0];
  if (!firstPart || firstPart === ".") return undefined;
  if (READ_ONLY_WORKSPACE_ROOTS.has(firstPart)) {
    return `Writing to ${relativePath} is not allowed: "${firstPart}/" holds user uploads and is read-only. Write results to "exports/" or "scratch/" instead.`;
  }
  if (RESERVED_WORKSPACE_ENTRIES.has(firstPart)) {
    return `Writing to ${relativePath} is not allowed: "${firstPart}" is a reserved system path.`;
  }
  if (DEFAULT_WRITE_DENY_DIRECTORIES.has(firstPart)) {
    return `Writing to ${relativePath} is not allowed by default.`;
  }
  return undefined;
}

/** 拒绝写入：先留审计（相对路径），再返回统一的 path_not_allowed。 */
function denyWorkspaceWrite(
  relativePath: string,
  message: string,
  context: PilotDeckToolRuntimeContext,
): PilotDeckPathSafetyResult {
  appendAudit(
    {
      action: "file.denied",
      decision: "deny",
      target: relativePath,
      reason: message,
      meta: { mode: context.permissionMode },
    },
    { env: context.env ?? process.env },
  );
  return { ok: false, error: toolError("path_not_allowed", message) };
}

/** Kept for callers that only need the boolean. */
export function isWorkspaceWriteDenied(relativePath: string): boolean {
  return writeDenialMessage(relativePath) !== undefined;
}

function safeRealpath(value: string): string | undefined {
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function isManagedImAttachmentFile(realPath: string, context: PilotDeckToolRuntimeContext): boolean {
  const pilotHome = path.resolve(context.env?.PILOT_HOME ?? path.join(homedir(), ".pilotdeck"));
  const root = safeRealpath(path.join(pilotHome, "im-attachments")) ?? path.join(pilotHome, "im-attachments");
  return isPathWithinRoot(realPath, root) && isRegularFile(realPath);
}

function isManagedChatAttachmentFile(realPath: string, context: PilotDeckToolRuntimeContext): boolean {
  if (!isRegularFile(realPath)) return false;

  const resolvedRealPath = safeRealpath(realPath) ?? path.resolve(realPath);
  const withinRoot = (root: string): boolean => {
    const resolvedRoot = safeRealpath(root) ?? path.resolve(root);
    return isPathWithinRoot(resolvedRealPath, resolvedRoot);
  };

  if (withinRoot(path.resolve(context.cwd, "inbox"))) return true;
  if (withinRoot(path.resolve(context.cwd, ".tmp", "chat-attachments"))) return true;

  const pilotHome = path.resolve(context.env?.PILOT_HOME ?? path.join(homedir(), ".pilotdeck"));
  if (withinRoot(path.join(pilotHome, ".tmp", "chat-attachments"))) return true;

  const workspacesRoot = path.join(pilotHome, "workspaces");
  if (!withinRoot(workspacesRoot)) return false;
  const relative = path.relative(safeRealpath(workspacesRoot) ?? workspacesRoot, resolvedRealPath).replace(/\\/g, "/");
  const segments = relative.split("/");
  return segments.length >= 3 && segments[2] === "inbox";
}

function isRegularFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}
