import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ProjectMetaType } from "./paths.js";

export type SkillAvailability = "global";

export const GLOBAL_SKILL_AVAILABILITY: readonly SkillAvailability[] = ["global"];
export const MED_MEDICAL_SKILL = "med-medical";

type AvailabilityFile = Record<string, SkillAvailability[]>;

export function normalizeSkillAvailability(value: unknown): SkillAvailability[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const hasValidValue = values.some((entry) =>
    entry === "global"
    || entry === "general_medicine"
    || entry === "war_trauma"
  );
  return hasValidValue ? ["global"] : [];
}

export function isValidSkillAvailabilityInput(value: unknown): value is SkillAvailability[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => entry === "global");
}

export function availabilityIncludesProjectType(
  _availability: readonly SkillAvailability[] | undefined,
  _projectType: ProjectMetaType,
): boolean {
  return true;
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
