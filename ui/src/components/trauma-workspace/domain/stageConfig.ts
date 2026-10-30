import type { MainStage, SubStage } from './types';
export { SUBSTAGE_LABELS } from './displayLabels';

export const SUBSTAGE_ORDER: readonly SubStage[] = [
  'primary_first_aid',
  'advanced_first_aid',
  'emergency_treatment',
  'surgical_resuscitation',
];

export const SUBSTAGE_TO_MAIN: Record<SubStage, MainStage> = {
  primary_first_aid: 'battlefield_first_aid',
  advanced_first_aid: 'battlefield_first_aid',
  emergency_treatment: 'early_treatment',
  surgical_resuscitation: 'early_treatment',
};

export function laterSubStages(current: SubStage | null | undefined): SubStage[] {
  if (!current) return [...SUBSTAGE_ORDER];
  const index = SUBSTAGE_ORDER.indexOf(current);
  if (index < 0) return [];
  return SUBSTAGE_ORDER.slice(index + 1);
}
