import type { ProjectMetaType } from "./paths.js";
import {
  availabilityIncludesProjectType,
  MED_MEDICAL_SKILL,
  readSkillAvailabilityOverrideSync,
  type SkillAvailability,
} from "./skillAvailability.js";

export type ProjectScopedSkill = {
  name: string;
  path: string;
  namespace?: string;
  availability?: readonly SkillAvailability[];
};

const MED_TOOLS_SKILLS: Record<ProjectMetaType, ReadonlySet<string>> = {
  general_medicine: new Set(["med-medical", "med-case-report"]),
  war_trauma: new Set(["med-medical", "med-trauma-assist", "med-trauma-stage-plan"]),
};

const MED_TOOLS: Record<ProjectMetaType, ReadonlySet<string>> = {
  general_medicine: new Set([
    "mcp__med-tools__med_parse_medical",
    "mcp__med-tools__med_tools_health",
  ]),
  war_trauma: new Set([
    "mcp__med-tools__med_parse_medical",
    "mcp__med-tools__med_trauma_rag_query",
    "mcp__med-tools__med_trauma_rag_status",
    "mcp__med-tools__med_trauma_stage_plan",
    "mcp__med-tools__med_tools_health",
  ]),
};

export function isSkillAvailableForProjectType(
  skill: ProjectScopedSkill,
  projectType: ProjectMetaType,
): boolean {
  const skillName = shortSkillName(skill.name);
  if (isMedToolsSkill(skill)) {
    if (skillName === MED_MEDICAL_SKILL) {
      return availabilityIncludesProjectType(
        readSkillAvailabilityOverrideSync(MED_MEDICAL_SKILL),
        projectType,
      );
    }
    return MED_TOOLS_SKILLS[projectType].has(skillName);
  }
  return availabilityIncludesProjectType(skill.availability, projectType);
}

export function filterSkillsForProjectType<T extends ProjectScopedSkill>(
  skills: readonly T[],
  projectType: ProjectMetaType,
): T[] {
  return skills.filter((skill) => isSkillAvailableForProjectType(skill, projectType));
}

export function isToolAvailableForProjectType(
  toolName: string,
  projectType: ProjectMetaType,
): boolean {
  if (!toolName.startsWith("mcp__med-tools__")) return true;
  if (toolName === "mcp__med-tools__med_parse_medical") {
    return availabilityIncludesProjectType(
      readSkillAvailabilityOverrideSync(MED_MEDICAL_SKILL),
      projectType,
    );
  }
  return MED_TOOLS[projectType].has(toolName);
}

export function filterToolsForProjectType<T extends { name: string }>(
  tools: readonly T[],
  projectType: ProjectMetaType,
): T[] {
  return tools.filter((tool) => isToolAvailableForProjectType(tool.name, projectType));
}

function isMedToolsSkill(skill: ProjectScopedSkill): boolean {
  if (skill.namespace === "med-tools") return true;
  return /[/\\]plugins[/\\]med-tools[/\\]skills[/\\]/u.test(skill.path);
}

function shortSkillName(name: string): string {
  const separator = name.lastIndexOf(":");
  return separator >= 0 ? name.slice(separator + 1) : name;
}
