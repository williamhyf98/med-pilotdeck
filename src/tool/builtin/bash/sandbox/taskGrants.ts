import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type TaskGrants = {
  inbox: string;
  writable: [string, string];
};

/** Fail closed before granting host paths to a registered document command. */
export function resolveTaskGrants(userHome: string, taskRoot: string): TaskGrants {
  const home = resolve(userHome);
  const task = resolve(taskRoot);
  const rel = relative(home, task);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Registered task must be inside the user home.");
  }
  const realHome = realpathSync(home);
  const realTask = realpathSync(task);
  if (!isWithin(realTask, realHome)) {
    throw new Error("Registered task resolves outside the user home.");
  }
  const inbox = join(task, "inbox");
  const scratch = join(task, "scratch");
  const exports = join(task, "exports");
  for (const dir of [inbox, scratch, exports]) {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || !isWithin(realpathSync(dir), realTask)) {
      throw new Error("Task roots must be real directories inside the current task.");
    }
  }
  return { inbox, writable: [scratch, exports] };
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
