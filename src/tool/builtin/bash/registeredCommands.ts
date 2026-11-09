import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DOCUMENT_COMMAND_SPECS, type DocumentOptionKind } from "../../../security/policy/documentCommandSpecs.js";
import type { CommandPolicy, CommandRule } from "../../../security/policy/parseCommandPolicy.js";

export type RegisteredBashCommand =
  | { kind: "workspace"; id: string; path: string; timeoutMs: number; visibleRoots: readonly string[] }
  | { kind: "script"; id: string; file: string; args: string[]; timeoutMs: number };

export type BashCommandScope = {
  cwd: string;
  appRoot: string;
  policy: CommandPolicy;
  /** Turn-scoped scratch/work directory exposed through $PILOTDECK_WORK_DIR. */
  workDir?: string;
};

export type StructuredCommandValue = string | number | boolean | readonly string[];

const SKILLS: Readonly<Record<string, { directory: string; script: string; variable: string }>> = {
  pdf: { directory: "pdf", script: "pdf.sh", variable: "PDF_SKILL_ROOT" },
  docx: { directory: "docx", script: "docx.sh", variable: "DOCX_SKILL_ROOT" },
  pptx: { directory: "pptx", script: "pptx.sh", variable: "PPTX_SKILL_ROOT" },
  spreadsheets: { directory: "spreadsheets", script: "spreadsheet.sh", variable: "SPREADSHEET_SKILL_ROOT" },
  diagram: { directory: "diagram-maker", script: "diagram.sh", variable: "DIAGRAM_SKILL_ROOT" },
};

const WORKSPACE_COMMANDS: Readonly<Record<string, string>> = {
  pwd: "workspace.pwd",
  ls: "workspace.list",
  stat: "workspace.stat",
  find: "workspace.find",
};

export function evaluateBashCommand(command: string, scope: BashCommandScope): RegisteredBashCommand {
  const tokens = tokenizeSingleCommand(command);
  if (tokens.length === 0) throw new Error("Empty command is not a registered capability.");
  const root = resolve(scope.cwd);
  const workspaceId = WORKSPACE_COMMANDS[tokens[0]!];
  if (workspaceId) {
    const rule = enabledRule(workspaceId, scope.policy);
    const args = tokens.slice(1);
    if (workspaceId === "workspace.pwd" && args.length !== 0) throw new Error("pwd takes no arguments.");
    if (workspaceId === "workspace.list" && args[0] === "-la") args.shift();
    if (workspaceId !== "workspace.pwd" && args.length > 1) throw new Error(`${tokens[0]} accepts one task path.`);
    if (args[0]?.startsWith("-")) throw new Error(`${tokens[0]} does not accept options.`);
    if (workspaceId === "workspace.find" && args.length === 0) throw new Error("find requires a task path.");
    const path = workspaceId === "workspace.pwd"
      ? root
      : resolveTaskPath(args[0] ?? ".", root, rule, "input", workspaceId === "workspace.list", scope.workDir);
    return { kind: "workspace", id: workspaceId, path, timeoutMs: rule.timeoutMs,
      visibleRoots: rule.inputRoots };
  }
  if (tokens[0] !== "bash" || tokens.length < 3) {
    throw new Error(`Unregistered command: ${tokens[0]}. Use a registered workspace check or document Skill.`);
  }
  const script = tokens[1]!;
  const operation = tokens[2]!;
  const skill = Object.entries(SKILLS).find(([, info]) => {
    const trusted = join(resolve(scope.appRoot), "skills", info.directory, "scripts", info.script);
    return script === `$${info.variable}/scripts/${info.script}` || script === trusted;
  });
  if (!skill) throw new Error("Unregistered script path; bundled Skill entrypoint required.");
  const [family, info] = skill;
  const id = `${family}.${operation}`;
  if (!Object.hasOwn(DOCUMENT_COMMAND_SPECS, id)) {
    throw new Error(`Unregistered capability ${id}; maintenance and arbitrary commands are unavailable.`);
  }
  const rule = enabledRule(id, scope.policy);
  const trustedFile = join(resolve(scope.appRoot), "skills", info.directory, "scripts", info.script);
  if (!realpathSync(trustedFile).startsWith(`${realpathSync(resolve(scope.appRoot))}${sep}`)) {
    throw new Error("Skill entrypoint resolves outside the installed application.");
  }
  const args = [trustedFile, operation];
  const optionSpecs = DOCUMENT_COMMAND_SPECS[id]!;
  const seen = new Set<string>();
  for (let index = 3; index < tokens.length; index += 1) {
    const flag = tokens[index]!;
    const type = optionSpecs[flag];
    if (!type || !rule.allowedOptions.includes(flag) || seen.has(flag)) {
      throw new Error(`Unregistered or repeated option ${flag} for capability ${id}.`);
    }
    seen.add(flag);
    args.push(flag);
    if (type === "switch") continue;
    let value = tokens[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires one value.`);
    if (type === "inputs") {
      const values = [value];
      while (tokens[index + 1] && !tokens[index + 1]!.startsWith("--")) {
        values.push(tokens[++index]!);
      }
      if (values.length > 20) throw new Error(`${flag} exceeds the maximum input count.`);
      args.push(...values.map((entry) => resolveTaskPath(entry, root, rule, "input", false, scope.workDir)));
      continue;
    }
    if (type === "input" || type === "output") {
      value = resolveTaskPath(value, root, rule, type, false, scope.workDir);
      if (type === "input" && /\.(?:sh|bash|py|pyw|js|mjs|cjs|ts|tsx|r|ipynb)$/iu.test(value)) {
        throw new Error("Executable source files are not document Skill inputs.");
      }
    } else if (type === "number") {
      const limit = ["--dpi"].includes(flag) ? 300
        : ["--max-rows", "--max-cols", "--max-items"].includes(flag) ? 10_000
        : ["--min-pages", "--max-pages"].includes(flag) ? 1_000
        : ["--degrees"].includes(flag) ? 360
        : ["--timeout"].includes(flag) ? 600_000 : 100;
      if (!/^\d+(?:\.\d+)?$/u.test(value) || Number(value) > limit) throw new Error(`Invalid numeric value for ${flag}.`);
    } else if (type === "text") {
      if (value.length > 100_000 || /[\0\u0001-\u0008\u000e-\u001f]/u.test(value)) {
        throw new Error(`${flag} contains invalid text.`);
      }
      validateEnumeratedOption(id, flag, value);
    }
    args.push(value);
  }
  if (id === "docx.deliver" && seen.has("--source") && seen.has("--new-document")) {
    throw new Error("Document delivery must choose one origin.");
  }
  return { kind: "script", id, file: "/bin/bash", args, timeoutMs: rule.timeoutMs };
}

/**
 * Build the same registered Skill argv as evaluateBashCommand, but from
 * server-owned structured values. The model never needs to construct the
 * shell-shaped command string used by the legacy compatibility entrypoint.
 */
export function evaluateStructuredCommand(
  id: string,
  options: Readonly<Record<string, StructuredCommandValue>>,
  scope: BashCommandScope,
): RegisteredBashCommand {
  const separator = id.indexOf(".");
  const family = separator > 0 ? id.slice(0, separator) : "";
  const operation = separator > 0 ? id.slice(separator + 1) : "";
  const skill = SKILLS[family];
  if (!skill || !operation || !Object.hasOwn(DOCUMENT_COMMAND_SPECS, id)) {
    throw new Error(`Unregistered capability ${id}; maintenance and arbitrary commands are unavailable.`);
  }

  const rule = enabledRule(id, scope.policy);
  const trustedFile = join(resolve(scope.appRoot), "skills", skill.directory, "scripts", skill.script);
  if (!realpathSync(trustedFile).startsWith(`${realpathSync(resolve(scope.appRoot))}${sep}`)) {
    throw new Error("Skill entrypoint resolves outside the installed application.");
  }

  const args = [trustedFile, operation];
  const optionSpecs = DOCUMENT_COMMAND_SPECS[id]!;
  const seen = new Set<string>();
  for (const [flag, rawValue] of Object.entries(options)) {
    const type = optionSpecs[flag];
    if (!type || !rule.allowedOptions.includes(flag) || seen.has(flag)) {
      throw new Error(`Unregistered or repeated option ${flag} for capability ${id}.`);
    }
    seen.add(flag);

    if (type === "switch") {
      if (rawValue !== true) throw new Error(`${flag} must be true when supplied.`);
      args.push(flag);
      continue;
    }

    if (type === "inputs") {
      if (!Array.isArray(rawValue) || rawValue.length === 0 || rawValue.length > 20
        || rawValue.some((value) => typeof value !== "string")) {
        throw new Error(`${flag} requires between 1 and 20 input paths.`);
      }
      args.push(flag, ...rawValue.map((value) =>
        resolveTaskPath(value, resolve(scope.cwd), rule, "input", false, scope.workDir)));
      continue;
    }

    if (typeof rawValue !== "string" && typeof rawValue !== "number") {
      throw new Error(`${flag} requires a scalar value.`);
    }
    const value = String(rawValue);
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires one value.`);

    if (type === "input" || type === "output") {
      const resolved = resolveTaskPath(value, resolve(scope.cwd), rule, type, false, scope.workDir);
      if (type === "input" && /\.(?:sh|bash|py|pyw|js|mjs|cjs|ts|tsx|r|ipynb)$/iu.test(resolved)) {
        throw new Error("Executable source files are not document Skill inputs.");
      }
      args.push(flag, resolved);
      continue;
    }

    if (type === "number") {
      const limit = ["--dpi"].includes(flag) ? 300
        : ["--max-rows", "--max-cols", "--max-items"].includes(flag) ? 10_000
        : ["--min-pages", "--max-pages"].includes(flag) ? 1_000
        : ["--degrees"].includes(flag) ? 360
        : ["--timeout"].includes(flag) ? 600_000 : 100;
      if (!/^\d+(?:\.\d+)?$/u.test(value) || Number(value) > limit) {
        throw new Error(`Invalid numeric value for ${flag}.`);
      }
    } else if (type === "text") {
      if (value.length > 100_000 || /[\0\u0001-\u0008\u000e-\u001f]/u.test(value)) {
        throw new Error(`${flag} contains invalid text.`);
      }
      validateEnumeratedOption(id, flag, value);
    }
    args.push(flag, value);
  }

  return { kind: "script", id, file: "/bin/bash", args, timeoutMs: rule.timeoutMs };
}

function enabledRule(id: string, policy: CommandPolicy): CommandRule {
  const rule = policy.commands.find((candidate) => candidate.id === id && candidate.enabled);
  if (!rule) throw new Error(`Capability ${id} is not enabled by the system command policy.`);
  return rule;
}

function resolveTaskPath(
  value: string, workspace: string, rule: CommandRule,
  access: "input" | "output", allowRoot = false, workDir?: string,
): string {
  if (value.includes("\0") || value.includes("\\") || value.split("/").includes("..")) throw new Error("Task path traversal is not allowed.");
  if (isAbsolute(value)) throw new Error("Absolute task paths must use $PWD.");
  const normalizedWorkDir = workDir ? validateWorkDir(workDir, workspace) : undefined;
  const expanded = value === "$PWD" ? workspace
    : value.startsWith("$PWD/") ? join(workspace, value.slice(5))
      : value === "$PILOTDECK_WORK_DIR" && normalizedWorkDir ? normalizedWorkDir
        : value.startsWith("$PILOTDECK_WORK_DIR/") && normalizedWorkDir
          ? join(normalizedWorkDir, value.slice("$PILOTDECK_WORK_DIR/".length))
          : value;
  if (expanded.includes("$") || expanded.startsWith("~")) {
    throw new Error("Only literal task paths, $PWD and $PILOTDECK_WORK_DIR are supported.");
  }
  const path = resolve(workspace, expanded);
  const rel = relative(workspace, path);
  if (!rel || isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === "..") {
    if (allowRoot && rel === "" && access === "input") return workspace;
    throw new Error("Only inbox, scratch and exports task paths are available.");
  }
  const root = rel.split(sep)[0]!;
  const allowedRoots = access === "input" ? rule.inputRoots : rule.outputRoots;
  if (!allowedRoots.includes(root as never) || (access === "output" && !rule.writable)) {
    throw new Error(`Capability ${rule.id} cannot ${access === "input" ? "read" : "write"} ${root}.`);
  }
  // Reject symlinks even when the target has not been created yet.
  let cursor = join(workspace, root);
  if (!lstatIfExists(cursor)?.isDirectory()) throw new Error(`Task root ${root} is unavailable or not a directory.`);
  for (const part of rel.split(sep).slice(1)) {
    if (lstatIfExists(cursor)?.isSymbolicLink()) throw new Error("Symlink task paths are not allowed.");
    cursor = join(cursor, part);
  }
  if (lstatIfExists(cursor)?.isSymbolicLink()) throw new Error("Symlink task paths are not allowed.");
  return path;
}

function validateWorkDir(workDir: string, workspace: string): string {
  const resolvedWorkDir = resolve(workDir);
  const relativeWorkDir = relative(workspace, resolvedWorkDir);
  if (
    !relativeWorkDir
    || isAbsolute(relativeWorkDir)
    || relativeWorkDir.startsWith(`..${sep}`)
    || relativeWorkDir === ".."
    || relativeWorkDir.split(sep)[0] !== "scratch"
    || relativeWorkDir.split(sep)[1] !== "work"
    || hasSymlinkComponent(resolvedWorkDir, workspace)
  ) {
    throw new Error("PILOTDECK_WORK_DIR must be inside the current task scratch/work directory.");
  }
  return resolvedWorkDir;
}

function hasSymlinkComponent(target: string, root: string): boolean {
  const relativeTarget = relative(root, target);
  if (!relativeTarget || isAbsolute(relativeTarget) || relativeTarget.startsWith(`..${sep}`)) return true;
  let cursor = resolve(root);
  for (const part of relativeTarget.split(sep)) {
    cursor = join(cursor, part);
    const info = lstatIfExists(cursor);
    if (info?.isSymbolicLink()) return true;
  }
  return false;
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateEnumeratedOption(id: string, flag: string, value: string): void {
  const allowed = flag === "--profile" ? ["draft", "final", "accessible"]
    : flag === "--command" && id === "docx.schema" ? ["create", "edit", "review"]
    : flag === "--direction" ? ["LR", "RL", "TB", "TD"]
    : flag === "--format" ? ["svg", "html"]
    : flag === "--theme" && id.startsWith("pptx.") ? ["clinical", "academic", "trauma", "vital", "mono"]
    : flag === "--theme" && id === "diagram.make" ? ["clean", "architecture"]
    : undefined;
  if (allowed && !allowed.includes(value)) throw new Error(`Invalid ${flag} value for ${id}.`);
}

function tokenizeSingleCommand(command: string): string[] {
  if (command.length > 200_000 || /[`]|\\\r|\$\(|\$\{|<<|>>/u.test(command)) {
    throw new Error("Shell evaluation, heredocs and command substitution are not available.");
  }
  const tokens: string[] = [];
  let value = "", started = false, quote: "'" | '"' | undefined;
  const push = () => { if (started) { tokens.push(value); value = ""; started = false; } };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) { quote = undefined; continue; }
      if (char === "\\" && quote === '"' && ['"', "\\"].includes(command[i + 1] ?? "")) {
        value += command[++i]; continue;
      }
      value += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "\\" && command[i + 1] === "\n") { i++; continue; }
    if (char === "\n" || /[;&|<>$\\\0]/u.test(char)) throw new Error("Only one literal registered command is allowed.");
    if (/\s/u.test(char)) { push(); continue; }
    value += char;
    started = true;
  }
  if (quote) throw new Error("Unterminated quoted argument.");
  push();
  return tokens;
}
