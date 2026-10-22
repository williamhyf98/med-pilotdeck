import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export type SandboxGrants = { readOnly: string[]; writable: string[]; metadataOnly?: string[] };

/** Resolve every spelling the OS may use when checking a grant. */
export function grantForms(input: string): string[] {
  const path = resolve(input);
  const paths = [path];
  try {
    const real = realpathSync(path);
    if (real !== path) paths.push(real);
  } catch { /* the caller decides whether a missing grant is valid */ }
  return paths;
}

export function appReadOnlyGrants(appRoot: string, nodeBinDir: string): string[] {
  const entries = ["dist", "node_modules", "skills", "plugins", join(".runtime", "node"), join(".runtime", "python"),
    join(".runtime", "cache", "xdg", "pilotdeck-pdf"),
    ...["docx", "pptx", "spreadsheets"].map((name) => join(".runtime", "cache", "xdg", `pilotdeck-${name}`))];
  return [...new Set([
    ...entries.map((entry) => join(appRoot, entry)).filter(existsSync),
    nodeBinDir,
  ])];
}

/** Pre-installed document runtimes are shared read-only; user outputs remain private. */
export function skillCacheEnv(appRoot: string): Record<string, string> {
  return Object.fromEntries(
    ([
      ["PDF_SKILL_CACHE", "pdf"],
      ["DOCX_SKILL_CACHE", "docx"],
      ["PPTX_SKILL_CACHE", "pptx"],
      ["SPREADSHEET_SKILL_CACHE", "spreadsheets"],
    ] as const).flatMap(([key, name]) => {
      const path = join(appRoot, ".runtime", "cache", "xdg", `pilotdeck-${name}`);
      return existsSync(path) ? [[key, path]] : [];
    }),
  );
}
