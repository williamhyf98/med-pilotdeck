import path from "node:path";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PilotDeckToolRuntimeContext } from "../../protocol/types.js";
import type { PilotDeckToolError } from "../../protocol/errors.js";
import { toolError } from "../../protocol/errors.js";

export type PilotDeckPathSafetyResult =
  | { ok: true; absolutePath: string; relativePath: string; root: string }
  | { ok: false; error: PilotDeckToolError };

const DEFAULT_WRITE_DENY_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

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

  const absolutePath = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(context.cwd, inputPath));

  // Multi-user hard boundary: applies in every permission mode, including
  // bypassPermissions, so a per-user Gateway can never touch paths outside its home.
  const userHomeError = userHomeViolation(absolutePath, context, options);
  if (userHomeError) {
    return { ok: false, error: userHomeError };
  }

  if (context.permissionMode === "bypassPermissions") {
    const relativePath = path.relative(context.cwd, absolutePath) || ".";
    if (options?.forWrite && isWriteDenied(relativePath)) {
      return {
        ok: false,
        error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
      };
    }
    return { ok: true, absolutePath, relativePath, root: context.cwd };
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
      if (options?.forWrite && isWriteDenied(relativePath)) {
        return {
          ok: false,
          error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
        };
      }
      return { ok: true, absolutePath, relativePath, root: context.cwd };
    }

    return {
      ok: false,
      error: toolError("path_not_allowed", `Path ${inputPath} is outside the PilotDeck workspace.`),
    };
  }

  const relativePath = path.relative(root, absolutePath) || ".";
  if (options?.forWrite && isWriteDenied(relativePath)) {
    return {
      ok: false,
      error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
    };
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
    return toolError("path_not_allowed", "Path is not within the allowed scope.");
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

function isWriteDenied(relativePath: string): boolean {
  const firstPart = relativePath.split(path.sep)[0];
  return firstPart !== undefined && DEFAULT_WRITE_DENY_DIRECTORIES.has(firstPart);
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
