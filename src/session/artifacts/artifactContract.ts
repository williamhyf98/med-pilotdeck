import { stat } from "node:fs/promises";
import path from "node:path";
import type { PilotDeckToolRuntimeContext } from "../../tool/protocol/types.js";
import type { PilotDeckToolArtifact } from "../../security/policy/types.js";
import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "../../tool/builtin/filesystem/pathSafety.js";

const MAX_ARTIFACTS = 64;
const MAX_PATH_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_MIME_TYPE_LENGTH = 200;

/**
 * Validate tool-declared files at the tool boundary. The collector still
 * supports legacy content/path discovery, but structured declarations must be
 * relative, existing regular files in the current task, and use the correct
 * output directory for their role.
 */
export async function normalizeToolArtifacts(
  value: unknown,
  context: PilotDeckToolRuntimeContext,
): Promise<PilotDeckToolArtifact[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARTIFACTS) {
    throw invalidArtifact("artifacts must be an array with at most 64 entries.");
  }

  const normalized: PilotDeckToolArtifact[] = [];
  const seen = new Map<string, PilotDeckToolArtifact["role"]>();
  for (const raw of value) {
    const artifact = parseArtifact(raw);
    if (path.isAbsolute(artifact.path) || artifact.path.includes("\\")
      || artifact.path.split("/").some((segment) => segment === "..")) {
      throw invalidArtifact(`Artifact path must be a relative task path: ${artifact.path}`);
    }

    const resolved = resolvePilotDeckWorkspacePath(artifact.path, context, {
      mustExist: true,
    });
    if (!resolved.ok) {
      throw invalidArtifact(`Artifact path is not available in the current task: ${artifact.path}`);
    }
    const relativePath = resolved.relativePath.replace(/\\/g, "/");
    if (!isRolePathAllowed(relativePath, artifact.role)) {
      throw invalidArtifact(
        `${artifact.role} artifact must be stored under ${artifact.role === "final" ? "exports/" : "scratch/"}: ${relativePath}`,
      );
    }
    const fileStat = await stat(resolved.absolutePath).catch(() => undefined);
    if (!fileStat?.isFile()) {
      throw invalidArtifact(`Artifact file does not exist or is not a regular file: ${relativePath}`);
    }

    const existingRole = seen.get(relativePath);
    if (existingRole && existingRole !== artifact.role) {
      throw invalidArtifact(`Duplicate artifact path has conflicting roles: ${relativePath}`);
    }
    if (existingRole) continue;

    const normalizedArtifact: PilotDeckToolArtifact = {
      path: relativePath,
      role: artifact.role,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.description ? { description: artifact.description } : {}),
    };
    seen.set(relativePath, artifact.role);
    normalized.push(normalizedArtifact);
  }
  return normalized;
}

function parseArtifact(value: unknown): PilotDeckToolArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArtifact("Each artifact must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim() || record.path.length > MAX_PATH_LENGTH) {
    throw invalidArtifact("Artifact path must be a non-empty string no longer than 1024 characters.");
  }
  if (record.role !== "final" && record.role !== "intermediate") {
    throw invalidArtifact("Artifact role must be final or intermediate.");
  }
  if (record.mimeType !== undefined
    && (typeof record.mimeType !== "string" || record.mimeType.length > MAX_MIME_TYPE_LENGTH)) {
    throw invalidArtifact("Artifact mimeType is invalid.");
  }
  if (record.description !== undefined
    && (typeof record.description !== "string" || record.description.length > MAX_DESCRIPTION_LENGTH)) {
    throw invalidArtifact("Artifact description is invalid.");
  }
  return {
    path: record.path.trim(),
    role: record.role,
    ...(typeof record.mimeType === "string" && record.mimeType ? { mimeType: record.mimeType } : {}),
    ...(typeof record.description === "string" && record.description ? { description: record.description } : {}),
  };
}

function isRolePathAllowed(relativePath: string, role: PilotDeckToolArtifact["role"]): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  const root = segments[0];
  if (role === "final") {
    return root === "exports"
      && segments.length > 1
      && !containsInternalSegment(segments.slice(1));
  }
  return root === "scratch" && segments.length > 1;
}

function containsInternalSegment(segments: string[]): boolean {
  const internal = new Set([
    ".git",
    ".pilotdeck",
    "node_modules",
    "qa",
    ".pdf-qa",
    ".docx-qa",
    ".pptx-qa",
    ".xlsx-qa",
    "derived",
  ]);
  return segments.some((segment) => internal.has(segment.toLowerCase()));
}

function invalidArtifact(message: string): PilotDeckToolRuntimeError {
  return new PilotDeckToolRuntimeError("tool_execution_failed", `Invalid tool artifact: ${message}`);
}
