#!/usr/bin/env node
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

function selectPython(root, platform = process.platform, exists = existsSync) {
  const candidate =
    platform === "win32"
      ? join(root, ".venv", "Scripts", "python.exe")
      : join(root, ".venv", "bin", "python");
  if (!exists(candidate)) {
    throw new Error(`mineru-ingest-tools: missing venv Python at ${candidate}`);
  }
  return candidate;
}

function parseConfigFile(file) {
  const values = {};
  if (!file || !existsSync(file)) return values;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`invalid config line in ${file}`);
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function configPath(env = process.env) {
  return (
    env.MED_RAG_MINERU_CONFIG_FILE ||
    (env.PILOT_HOME && join(env.PILOT_HOME, "med-tools", "mineru-ingest.env")) ||
    ""
  );
}

function buildChildEnv(env = process.env, root = __dirname) {
  const file = configPath(env);
  const configured = parseConfigFile(file);
  const child = { ...env, ...configured };
  child.PILOT_HOME = env.PILOT_HOME || configured.PILOT_HOME || "";
  child.PILOTDECK_DISABLE_LOCAL_AUTH =
    env.PILOTDECK_DISABLE_LOCAL_AUTH ||
    configured.PILOTDECK_DISABLE_LOCAL_AUTH ||
    "0";
  child.HOME = env.HOME || child.PILOT_HOME || homedir();
  child.PATH = env.PATH || process.env.PATH || "";
  child.MED_RAG_MINERU_CONFIG_FILE = file;
  child.MED_RAG_MINERU_MCP_TRANSPORT = "stdio";
  return child;
}

function main() {
  const root = __dirname;
  let python;
  try {
    python = selectPython(root);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const child = spawn(
    python,
    ["-m", "server.mineru_ingest_app"],
    { cwd: root, env: buildChildEnv(), stdio: "inherit" },
  );
  child.on("error", (error) => {
    console.error(`mineru-ingest-tools: failed to launch: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

module.exports = { selectPython, parseConfigFile, configPath, buildChildEnv };

if (require.main === module) main();
