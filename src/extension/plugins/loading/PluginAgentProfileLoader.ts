import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  parseMarkdownAgentProfile,
  type AgentProfile,
} from "../../../agent/index.js";
import type { PilotDeckPluginSourceKind } from "../protocol/plugin.js";

export async function loadPluginAgentProfiles(input: {
  pluginName: string;
  pluginPath: string;
  source: PilotDeckPluginSourceKind;
  configured?: string | string[];
}): Promise<AgentProfile[]> {
  const configuredPaths = input.configured === undefined
    ? ["agents"]
    : Array.isArray(input.configured) ? input.configured : [input.configured];
  const root = await realpath(input.pluginPath);
  const files: string[] = [];
  for (const configuredPath of configuredPaths) {
    if (isAbsolute(configuredPath)) {
      throw new Error(`Agent profile path must be relative: ${configuredPath}`);
    }
    const candidate = resolve(root, configuredPath);
    assertWithinPlugin(root, candidate);
    files.push(...await collectMarkdownFiles(root, candidate));
  }
  files.sort((left, right) => left.localeCompare(right));
  return Promise.all(files.map(async (filePath) => {
    const raw = await readFile(filePath, "utf8");
    const { frontmatter, content } = parseMarkdownFrontmatter(raw);
    return parseMarkdownAgentProfile(frontmatter, content, {
      pluginName: input.pluginName,
      pluginSource: input.source,
      path: filePath,
    });
  }));
}

async function collectMarkdownFiles(root: string, candidate: string): Promise<string[]> {
  let candidateStat;
  try {
    candidateStat = await stat(candidate);
  } catch {
    return [];
  }
  const canonical = await realpath(candidate);
  assertWithinPlugin(root, canonical);
  if (candidateStat.isFile()) {
    return /\.md$/iu.test(basename(canonical)) ? [canonical] : [];
  }
  if (!candidateStat.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of await readdir(canonical)) {
    files.push(...await collectMarkdownFiles(root, resolve(canonical, entry)));
  }
  return files;
}

function parseMarkdownFrontmatter(rawInput: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const raw = rawInput.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (!raw.startsWith("---\n")) {
    throw new Error("Agent profile Markdown must start with YAML frontmatter.");
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("Agent profile Markdown has unterminated YAML frontmatter.");
  }
  const parsed = parseYaml(raw.slice(4, end)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Agent profile YAML frontmatter must be an object.");
  }
  return {
    frontmatter: parsed,
    content: raw.slice(end + 5),
  };
}

function assertWithinPlugin(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return;
  throw new Error(`Agent profile path escapes plugin root: ${candidate}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
