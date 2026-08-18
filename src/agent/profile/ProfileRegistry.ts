import type { AgentProfile, AgentProfileResolver } from "./types.js";

export class ProfileRegistry implements AgentProfileResolver {
  private readonly profiles = new Map<string, AgentProfile>();
  private selected: AgentProfile[] = [];

  replaceAll(profiles: readonly AgentProfile[]): void {
    this.profiles.clear();
    const ordered = [...profiles].sort((left, right) => {
      const priority = sourcePriority(left) - sourcePriority(right);
      if (priority !== 0) return priority;
      return (left.source?.path ?? left.id).localeCompare(right.source?.path ?? right.id);
    });
    for (const profile of ordered) {
      const copy = cloneProfile(profile);
      this.profiles.set(copy.id, copy);
      if (copy.source?.pluginName) {
        this.profiles.set(`${copy.source.pluginName}:${copy.id}`, copy);
      }
    }
    this.selected = [...new Set(this.profiles.values())];
  }

  get(id: string): AgentProfile | undefined {
    const profile = this.profiles.get(id);
    return profile ? cloneProfile(profile) : undefined;
  }

  list(): AgentProfile[] {
    return this.selected.map(cloneProfile);
  }
}

function sourcePriority(profile: AgentProfile): number {
  switch (profile.source?.pluginSource) {
    case "project":
      return 2;
    case "global":
      return 1;
    case "builtin":
    default:
      return 0;
  }
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    thinking: profile.thinking ? { ...profile.thinking } : undefined,
    allowedTools: profile.allowedTools ? [...profile.allowedTools] : undefined,
    deniedTools: profile.deniedTools ? [...profile.deniedTools] : undefined,
    metadata: profile.metadata ? structuredClone(profile.metadata) : undefined,
    source: profile.source ? { ...profile.source } : undefined,
  };
}
