import type { MainStage, SubStage } from './types';

export const SUBSTAGE_ORDER: readonly SubStage[] = [
  'primary_first_aid',
  'advanced_first_aid',
  'emergency_treatment',
  'surgical_resuscitation',
  'field_specialist_treatment',
  'definitive_specialist_treatment',
  'functional_recovery',
  'psychophysical_rehabilitation',
];

export const SUBSTAGE_TO_MAIN: Record<SubStage, MainStage> = {
  primary_first_aid: 'battlefield_first_aid',
  advanced_first_aid: 'battlefield_first_aid',
  emergency_treatment: 'early_treatment',
  surgical_resuscitation: 'early_treatment',
  field_specialist_treatment: 'specialist_treatment',
  definitive_specialist_treatment: 'specialist_treatment',
  functional_recovery: 'rehabilitation',
  psychophysical_rehabilitation: 'rehabilitation',
};

export const SUBSTAGE_LABELS: Record<SubStage, string> = {
  primary_first_aid: '初级急救',
  advanced_first_aid: '高级急救',
  emergency_treatment: '紧急救治',
  surgical_resuscitation: '紧急手术复苏',
  field_specialist_treatment: '野战专科治疗',
  definitive_specialist_treatment: '确定性专科治疗',
  functional_recovery: '功能恢复',
  psychophysical_rehabilitation: '身心康复',
};

export function laterSubStages(current: SubStage): SubStage[] {
  const index = SUBSTAGE_ORDER.indexOf(current);
  return SUBSTAGE_ORDER.slice(index + 1);
}
