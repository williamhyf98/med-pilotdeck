import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ProjectMetaType } from "./paths.js";

export type SkillAvailability = "global" | ProjectMetaType;

export const GLOBAL_SKILL_AVAILABILITY: readonly SkillAvailability[] = ["global"];
export const MED_MEDICAL_SKILL = "med-medical";

type AvailabilityFile = Record<string, SkillAvailability[]>;

export function normalizeSkillAvailability(value: unknown): SkillAvailability[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const unique = new Set<SkillAvailability>();
  for (const entry of values) {
    if (
      entry === "global"
      || entry === "general_medicine"
      || entry === "war_trauma"
    ) {
      unique.add(entry);
    }
  }
  if (
    unique.has("global")
    || (unique.has("general_medicine") && unique.has("war_trauma"))
  ) {
    return ["global"];
  }
  return [...unique];
}

export function isValidSkillAvailabilityInput(value: unknown): value is SkillAvailability[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) =>
      entry === "global"
      || entry === "general_medicine"
      || entry === "war_trauma"
    );
}

export function availabilityIncludesProjectType(
  availability: readonly SkillAvailability[] | undefined,
  projectType: ProjectMetaType,
): boolean {
  if (!availability || availability.length === 0) return true;
  return availability.includes("global") || availability.includes(projectType);
}

export function skillAvailabilityFile(pilotHome = resolvePilotHome()): string {
  return join(pilotHome, "skill-availability.json");
}

export function readSkillAvailabilityOverrideSync(
  slug: string,
  pilotHome = resolvePilotHome(),
): SkillAvailability[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(skillAvailabilityFile(pilotHome), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const normalized = normalizeSkillAvailability((parsed as AvailabilityFile)[slug]);
    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSkillAvailabilityOverride(
  slug: string,
  availability: readonly SkillAvailability[],
  pilotHome = resolvePilotHome(),
): Promise<void> {
  if (!isValidSkillAvailabilityInput(availability)) {
    throw new Error("Skill availability contains an invalid option.");
  }
  const normalized = normalizeSkillAvailability(availability);
  if (normalized.length === 0) {
    throw new Error("At least one skill availability must be selected.");
  }
  const file = skillAvailabilityFile(pilotHome);
  let current: AvailabilityFile = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as AvailabilityFile;
    }
  } catch {
    // A missing or malformed optional override file starts from defaults.
  }
  current[slug] = normalized;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function resolvePilotHome(): string {
  return process.env.PILOT_HOME || join(homedir(), ".pilotdeck");
}
