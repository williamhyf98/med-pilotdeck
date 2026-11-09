import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { PilotDeckCommandResult } from "./commandRunner.js";
import type { RegisteredBashCommand } from "./registeredCommands.js";

const MAX_RESULTS = 100;
const MAX_DEPTH = 5;

export function inspectWorkspace(
  command: Extract<RegisteredBashCommand, { kind: "workspace" }>,
  cwd: string,
): PilotDeckCommandResult {
  const start = Date.now();
  const lines: string[] = [];
  if (command.id === "workspace.pwd") {
    lines.push(cwd);
  } else if (command.path === cwd) {
    lines.push(...command.visibleRoots);
  } else {
    const info = lstatSync(command.path);
    if (info.isSymbolicLink()) throw new Error("Symlink task paths are not allowed.");
    if (command.id === "workspace.stat") {
      lines.push(`${relative(cwd, command.path)}\t${info.isDirectory() ? "directory" : "file"}\t${info.size}\t${info.mtime.toISOString()}`);
    } else if (!info.isDirectory()) {
      throw new Error("Inspection target must be a task directory.");
    } else if (command.id === "workspace.list") {
      lines.push(...readdirSync(command.path, { withFileTypes: true }).slice(0, MAX_RESULTS)
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? " (symlink)" : ""}`));
    } else if (command.id === "workspace.find") {
      const walk = (directory: string, depth: number) => {
        if (depth > MAX_DEPTH || lines.length >= MAX_RESULTS) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (lines.length >= MAX_RESULTS) break;
          const path = join(directory, entry.name);
          lines.push(`${relative(cwd, path)}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? " (symlink)" : ""}`);
          if (entry.isDirectory()) walk(path, depth + 1);
        }
      };
      walk(command.path, 0);
    } else {
      throw new Error(`Unknown workspace inspection ${command.id}.`);
    }
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "",
    timedOut: false, durationMs: Date.now() - start };
}
