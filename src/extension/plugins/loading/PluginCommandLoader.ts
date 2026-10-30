import { basename, dirname, join, relative } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export type LoadedPluginCommand = {
  name: string;
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  isSkill: boolean;
};

export async function loadPluginCommands(options: {
  pluginName: string;
  baseDir: string;
}): Promise<LoadedPluginCommand[]> {
  const files = await collectMarkdownFiles(options.baseDir);
  return Promise.all(
    files.map((filePath) => loadMarkdownContribution(
      filePath,
      getPluginCommandName(options.pluginName, filePath, options.baseDir),
    )),
  );
}

/**
 * Load the single root SKILL.md from a standalone skill directory.
 *
 * Standalone skills are not plugin namespaces: their directory slug is the
 * model-facing identifier. Loading the whole directory through
 * `loadPluginCommands` would both derive a bogus `..` namespace for the root
 * file and expose reference markdown files as additional skills.
 */
export async function loadStandaloneSkill(options: {
  name: string;
  skillDir: string;
}): Promise<LoadedPluginCommand> {
  const entries = await readdir(options.skillDir);
  const skillFileName = entries.find((entry) => /^skill\.md$/iu.test(entry));
  if (!skillFileName) {
    throw new Error(`Standalone skill '${options.name}' has no SKILL.md.`);
  }
  return loadMarkdownContribution(join(options.skillDir, skillFileName), options.name);
}

export function getPluginCommandName(pluginName: string, filePath: string, baseDir: string): string {
  const skillFile = isSkillFile(filePath);
  const contributionDir = dirname(filePath);
  const baseName = skillFile ? basename(contributionDir) : basename(filePath).replace(/\.md$/iu, "");
  const namespaceRoot = skillFile && relative(baseDir, contributionDir) !== ""
    ? dirname(contributionDir)
    : contributionDir;
  const namespace = relative(baseDir, namespaceRoot)
    .split(/[\\/]/u)
    .filter(Boolean)
    .join(":");

  return namespace ? `${pluginName}:${namespace}:${baseName}` : `${pluginName}:${baseName}`;
}

function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/iu.test(basename(filePath));
}

async function loadMarkdownContribution(
  filePath: string,
  name: string,
): Promise<LoadedPluginCommand> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseMarkdownFrontmatter(raw);
  return {
    name,
    path: filePath,
    content: parsed.content,
    frontmatter: parsed.frontmatter,
    isSkill: isSkillFile(filePath),
  };
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return output;
  }

  for (const entry of entries) {
    const fullPath = join(directory, entry);
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }
    if (entryStat.isDirectory()) {
      output.push(...await collectMarkdownFiles(fullPath));
    } else if (/\.md$/iu.test(entry)) {
      output.push(fullPath);
    }
  }
  return output;
}

function parseMarkdownFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  // Tolerate CRLF (Windows checkout) as well as LF line endings. The strict
  // `---\n` match silently returned an empty frontmatter for CRLF SKILL.md
  // files, dropping skill name/description from <available-skills>.
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, content: raw };
  }
  const fmBodyStart = raw.startsWith("---\r\n") ? 5 : raw.startsWith("---\n") ? 4 : -1;
  if (fmBodyStart === -1) {
    return { frontmatter: {}, content: raw };
  }
  const end = raw.indexOf("\n---", fmBodyStart);
  if (end === -1) {
    return { frontmatter: {}, content: raw };
  }
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(raw.slice(fmBodyStart, end));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid frontmatter is reported by the skill validator.
  }
  const contentStart = end + (raw[end + 4] === "\r" ? 6 : 5);
  return { frontmatter, content: raw.slice(contentStart) };
}
