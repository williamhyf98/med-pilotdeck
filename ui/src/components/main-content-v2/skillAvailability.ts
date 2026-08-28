export type SkillAvailability = 'global' | 'general_medicine' | 'war_trauma';

export function availabilityBucket(
  availability: readonly SkillAvailability[],
): SkillAvailability {
  return availability.length === 1 ? availability[0] ?? 'global' : 'global';
}

export function nextSkillAvailability(
  current: readonly SkillAvailability[],
  toggled: SkillAvailability,
): SkillAvailability[] {
  const selected = new Set(current);
  if (toggled === 'global') return ['global'];
  const next = new Set<SkillAvailability>(selected.has('global') ? [] : current);
  if (next.has(toggled)) {
    if (next.size === 1) return [...current];
    next.delete(toggled);
  } else {
    next.add(toggled);
  }
  return next.size === 2 ? ['global'] : [...next];
}
