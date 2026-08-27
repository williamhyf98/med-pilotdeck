import type { Project, ProjectType } from '../../types/app';

/** Legacy virtual chat workspace row (P2 no longer injects this). */
export function isVirtualGeneralProject(project: Project): boolean {
  return project.name === 'general' || project.displayName === 'general';
}

/** @deprecated Use isVirtualGeneralProject */
export function isGeneralProject(project: Project): boolean {
  return isVirtualGeneralProject(project);
}

/**
 * Resolve typed project kind for sidebar filtering (P3).
 * Prefer API fields; fall back to id prefix `general_med-` / `trauma_med-`.
 */
export function resolveProjectType(project: Project): ProjectType | null {
  const explicit = project.projectType ?? project.type;
  if (explicit === 'general_medicine' || explicit === 'war_trauma') {
    return explicit;
  }
  const id = String(project.name || '').trim();
  if (id.startsWith('general_med-')) return 'general_medicine';
  if (id.startsWith('trauma_med-')) return 'war_trauma';
  return null;
}

export function filterProjectsByType(
  projects: readonly Project[],
  type: ProjectType,
): Project[] {
  return projects.filter((project) => {
    if (isVirtualGeneralProject(project)) return false;
    return resolveProjectType(project) === type;
  });
}

/**
 * Choose the project used when the shell starts without an explicit route.
 * Prefers a real (non-virtual-general) project. Returns null when the list
 * is empty so the empty state can prompt create-project (P2).
 */
export function chooseDefaultProject(projects: readonly Project[]): Project | null {
  return projects.find((project) => !isVirtualGeneralProject(project)) ?? null;
}
