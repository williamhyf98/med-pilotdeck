import type { ProjectMetaType } from "./paths.js";
import {
  availabilityIncludesProjectType,
  type SkillAvailability,
} from "./skillAvailability.js";

export type ProjectScopedSkill = {
  name: string;
  path: string;
  namespace?: string;
  availability?: readonly SkillAvailability[];
};

export function isSkillAvailableForProjectType(
  skill: ProjectScopedSkill,
  projectType: ProjectMetaType,
): boolean {
  // All bundled medical skills are global. Project types now describe product
  // experiences, not capability silos.
  if (isMedToolsSkill(skill)) return true;
  return availabilityIncludesProjectType(skill.availability, projectType);
}

export function filterSkillsForProjectType<T extends ProjectScopedSkill>(
  skills: readonly T[],
  projectType: ProjectMetaType,
): T[] {
  return skills.filter((skill) => isSkillAvailableForProjectType(skill, projectType));
}

export function isToolAvailableForProjectType(
  _toolName: string,
  _projectType: ProjectMetaType,
): boolean {
  // med-tools capabilities are global, including trauma RAG and staged plans.
  return true;
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
