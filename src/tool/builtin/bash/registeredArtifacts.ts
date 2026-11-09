import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { PilotDeckToolArtifact } from "../../protocol/types.js";

const PATH_RESULT_KEYS = new Set([
  "audit",
  "audits",
  "montage",
  "output",
  "outputs",
  "page",
  "pages",
  "preview",
  "pdf",
  "report",
  "reports",
]);

const INTERNAL_SEGMENTS = new Set([
  ".docx-qa",
  ".pdf-qa",
  ".pptx-qa",
  ".xlsx-qa",
  "qa",
]);

/**
 * Document Skills emit machine-readable JSON but historically returned only
 * text through Bash. Extract only explicit path-shaped result fields and turn
 * existing task-local files into the common artifact contract.
 */
export function extractRegisteredArtifacts(
  stdout: string,
  taskRoot: string,
): PilotDeckToolArtifact[] {
  const payload = parseJsonPayload(stdout);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];

  const task = realpathSync(resolve(taskRoot));
  const candidates: string[] = [];
  collectPathValues(payload, undefined, candidates);
  const seen = new Set<string>();
  const artifacts: PilotDeckToolArtifact[] = [];

  for (const value of candidates) {
    const candidate = isAbsolute(value) ? resolve(value) : resolve(taskRoot, value);
    let real: string;
    try {
      real = realpathSync(candidate);
      const info = lstatSync(real);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    const relativePath = relative(task, real).replace(/\\/g, "/");
    const segments = relativePath.split("/").filter(Boolean);
    const root = segments[0];
    if (!root || segments.length < 2 || (root !== "scratch" && root !== "exports")) continue;
    if (segments.some((segment) => INTERNAL_SEGMENTS.has(segment.toLowerCase()))) continue;
    if (!seen.add(relativePath)) continue;

    artifacts.push({
      path: relativePath,
      role: root === "exports" ? "final" : "intermediate",
    });
  }
  return artifacts;
}

export function normalizeRegisteredOutput(value: string, taskRoot: string): string {
  if (!value) return value;
  const normalizedRoot = resolve(taskRoot).replace(/\\/g, "/");
  try {
    const parsed = JSON.parse(value) as unknown;
    return `${JSON.stringify(normalizeOutputValue(parsed, normalizedRoot), null, 2)}\n`;
  } catch {
    const escapedRoot = normalizedRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return value.replace(new RegExp(`${escapedRoot}(?=/|$)`, "gu"), "");
  }
}

function normalizeOutputValue(value: unknown, normalizedRoot: string): unknown {
  if (typeof value === "string") {
    const normalizedValue = value.replace(/\\/g, "/");
    if (normalizedValue === normalizedRoot) return ".";
    if (normalizedValue.startsWith(`${normalizedRoot}/`)) {
      return normalizedValue.slice(normalizedRoot.length + 1);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeOutputValue(item, normalizedRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, normalizeOutputValue(item, normalizedRoot)]),
    );
  }
  return value;
}

function collectPathValues(value: unknown, key: string | undefined, output: string[]): void {
  if (typeof value === "string") {
    if (key && PATH_RESULT_KEYS.has(key.toLowerCase()) && value.trim()) output.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, key, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryKey.toLowerCase() === "path"
      && key
      && ["pages", "outputs", "reports", "audits"].includes(key.toLowerCase())) {
      if (typeof entryValue === "string" && entryValue.trim()) output.push(entryValue.trim());
      continue;
    }
    collectPathValues(entryValue, entryKey, output);
  }
}

function parseJsonPayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some bundled entrypoints may emit one diagnostic line before JSON.
    for (const line of trimmed.split(/\r?\n/u).reverse()) {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        // Try the next line.
      }
    }
    return undefined;
  }
}
