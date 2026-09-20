import {
  isBackgroundTaskSession,
  type AppTab,
  type Project,
  type ProjectSession,
  type ProjectType,
} from '../../types/app';

const asTimestamp = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const sessionLastActivity = (session: ProjectSession): number => Math.max(
  asTimestamp(session.lastActivity),
  asTimestamp(session.updated_at),
  asTimestamp(session.createdAt),
  asTimestamp(session.created_at),
);

const projectLastActivity = (project: Project): number => Math.max(
  asTimestamp(project.lastActivity),
  asTimestamp(project.updated_at),
  asTimestamp(project.createdAt),
  asTimestamp(project.created_at),
);

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

export type RecentSessionTarget = {
  project: Project;
  session: ProjectSession;
};

export function findMostRecentSessionTarget(
  projects: readonly Project[],
  type: ProjectType,
): RecentSessionTarget | null {
  let target: RecentSessionTarget | null = null;
  let targetActivity = Number.NEGATIVE_INFINITY;

  for (const project of filterProjectsByType(projects, type)) {
    for (const session of project.sessions ?? []) {
      if (isBackgroundTaskSession(session)) continue;
      const activity = sessionLastActivity(session);
      if (activity > targetActivity) {
        target = { project, session };
        targetActivity = activity;
      }
    }
  }

  return target;
}

export function findMostRecentProject(
  projects: readonly Project[],
  type: ProjectType,
): Project | null {
  return filterProjectsByType(projects, type).reduce<Project | null>((latest, project) => {
    if (!latest) return project;
    return projectLastActivity(project) > projectLastActivity(latest) ? project : latest;
  }, null);
}

/**
 * Choose the project used when the shell starts without an explicit route.
 * Prefers a real (non-virtual-general) project. Returns null when the list
 * is empty so the empty state can prompt create-project (P2).
 */
export function chooseDefaultProject(projects: readonly Project[]): Project | null {
  return projects.find((project) => !isVirtualGeneralProject(project)) ?? null;
}

export function shouldPreserveTabOnSessionSelection(
  activeTab: AppTab,
  explicitlyPreserve = false,
): boolean {
  return explicitlyPreserve || activeTab === 'memory';
}
