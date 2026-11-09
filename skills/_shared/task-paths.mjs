import fs from "node:fs";
import path from "node:path";

const TASK_ROOT_ENV = "PILOTDECK_WORKSPACE_DIR";
const TASK_ROOT_FALLBACK_ENV = "PILOTDECK_WORKSPACE_CWD";
const TASK_ROOTS = new Set(["inbox", "scratch", "exports"]);

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function existingRealpath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

function hasSymlinkComponent(candidate, root) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return true;
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

export function pilotDeckTaskRoot() {
  const configured = String(
    process.env[TASK_ROOT_ENV] ?? process.env[TASK_ROOT_FALLBACK_ENV] ?? "",
  ).trim();
  if (!configured) return null;
  const root = path.resolve(configured);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`${TASK_ROOT_ENV} does not identify an existing task directory`);
  }
  return root;
}

/**
 * Resolve a local resource used by a declarative Skill spec.
 * Agent-visible runs are limited to the current task's three data roots.
 * Standalone maintenance runs retain their historical local-path behavior.
 */
export function resolveTaskResource(value, baseDir, label = "resource") {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${label} path is required`);
  if (/^https?:\/\//iu.test(raw)) {
    throw new Error(`${label}: remote resources are not allowed; use a local task file`);
  }

  const candidate = path.resolve(baseDir, raw);
  const taskRoot = pilotDeckTaskRoot();
  if (!taskRoot) return candidate;

  if (!isInside(candidate, taskRoot)) {
    throw new Error(`${label} must resolve to a file inside the current task`);
  }
  if (hasSymlinkComponent(candidate, taskRoot)) {
    throw new Error(`${label} cannot use a symbolic-link path`);
  }

  const realTaskRoot = existingRealpath(taskRoot) ?? taskRoot;
  const realResource = existingRealpath(candidate);
  if (!realResource || !isInside(realResource, realTaskRoot)) {
    throw new Error(`${label} must resolve to a file inside the current task`);
  }
  const relative = path.relative(realTaskRoot, realResource);
  const firstPart = relative.split(path.sep)[0];
  if (!firstPart || !TASK_ROOTS.has(firstPart)) {
    throw new Error(`${label} must be under inbox, scratch, or exports`);
  }
  if (!fs.statSync(realResource).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return realResource;
}

export function assertTaskResource(value, label = "resource") {
  return resolveTaskResource(value, process.cwd(), label);
}
