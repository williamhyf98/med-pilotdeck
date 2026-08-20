#!/usr/bin/env node
/**
 * Launch the med-tools MCP server (stdio) cross-platform.
 *
 * plugin.json points here instead of run.sh so the gateway never depends on
 * shell resolution: on Windows, plain `bash` can resolve to WSL's bash
 * (C:\Windows\System32\bash.exe), which cannot read Windows paths. Node is
 * always available — the gateway itself runs on it.
 */
"use strict";

const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { existsSync } = require("node:fs");

const root = __dirname;
const candidates =
  process.platform === "win32"
    ? [join(root, ".venv", "Scripts", "python.exe")]
    : [join(root, ".venv", "bin", "python")];
const python = candidates.find((p) => existsSync(p));
if (!python) {
  console.error(`med-tools: missing venv at ${join(root, ".venv")}. Run: ${join(root, "setup.sh")}`);
  process.exit(1);
}
const child = spawn(python, ["-m", "server"], { cwd: root, stdio: "inherit" });
child.on("error", (err) => {
  console.error(`med-tools: failed to launch ${python}: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
