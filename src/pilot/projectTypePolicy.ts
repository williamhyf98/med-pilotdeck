import type { ProjectMetaType } from "./paths.js";
import type { SkillAvailability } from "./skillAvailability.js";
import { isMedicalSkillAvailable, isMedToolDisabled } from "./medicalCapabilities.js";

export type ProjectScopedSkill = {
  name: string;
  path: string;
  namespace?: string;
  availability?: readonly SkillAvailability[];
};

export function isSkillAvailableForProjectType(
  skill: ProjectScopedSkill,
  _projectType: ProjectMetaType,
): boolean {
  return isMedicalSkillAvailable(skill.name);
}

export function filterSkillsForProjectType<T extends ProjectScopedSkill>(
  skills: readonly T[],
  projectType: ProjectMetaType,
): T[] {
  return skills.filter((skill) => isSkillAvailableForProjectType(skill, projectType));
}

export function isToolAvailableForProjectType(
  toolName: string,
  _projectType: ProjectMetaType,
): boolean {
  // med-tools capabilities are global, including trauma RAG and staged plans.
  return !isMedToolDisabled(toolName);
}

export function filterToolsForProjectType<T extends { name: string }>(
  tools: readonly T[],
  projectType: ProjectMetaType,
): T[] {
  return tools.filter((tool) => isToolAvailableForProjectType(tool.name, projectType));
}
