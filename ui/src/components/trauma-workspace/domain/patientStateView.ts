import type { CaseState, VitalItemKey } from './types';

export type PatientStateView = {
  updatedAt: string;
  consciousness: string;
  vitals: Array<{
    label: string;
    value: string;
    trend: 'up' | 'down' | 'flat' | 'unknown';
    abnormal: boolean;
  }>;
  injuries: Array<{
    label: string;
    certainty: '已确认';
    status: string;
  }>;
  treatments: string[];
  missingInformation: string[];
};

function trend(current?: number, previous?: number): PatientStateView['vitals'][number]['trend'] {
  if (current === undefined || previous === undefined) return 'unknown';
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

const vitalDefinitions: Array<{
  key: VitalItemKey;
  label: string;
  unit: string;
  abnormal: (value: number) => boolean;
}> = [
  { key: 'respiratoryRate', label: '呼吸', unit: '次/分', abnormal: (value) => value > 20 },
  { key: 'systolicBloodPressure', label: '收缩压', unit: 'mmHg', abnormal: (value) => value < 90 },
  { key: 'gcs', label: 'GCS', unit: '', abnormal: (value) => value < 15 },
  { key: 'heartRate', label: '心率', unit: '次/分', abnormal: (value) => value > 100 },
  { key: 'temperature', label: '体温', unit: '℃', abnormal: (value) => value < 36 || value > 37.5 },
];

function measuredValues(state: CaseState, key: VitalItemKey) {
  return state.vitalSignsHistory
    .filter((record) => record.values[key] !== undefined)
    .map((record) => ({ round: record.round, value: record.values[key]! }));
}

export function derivePatientStateView(state: CaseState): PatientStateView {
  const vitals = vitalDefinitions.map((definition) => {
    const records = measuredValues(state, definition.key);
    const current = records.at(-1);
    const previous = records.at(-2);
    return {
      label: definition.label,
      value: current
        ? `${current.value}${definition.unit ? ` ${definition.unit}` : ''} · R${current.round}`
        : '未测',
      trend: trend(current?.value, previous?.value),
      abnormal: current ? definition.abnormal(current.value) : false,
    };
  });
  const latestGcs = measuredValues(state, 'gcs').at(-1);

  return {
    updatedAt: new Date(state.updatedAt).toLocaleString(),
    consciousness: latestGcs ? `GCS ${latestGcs.value} · R${latestGcs.round}` : '尚未记录',
    vitals,
    injuries: state.injuryNarratives.map((entry) => ({
      label: `R${entry.round} · ${entry.text}`,
      certainty: '已确认',
      status: '叙述记录',
    })),
    treatments: state.treatmentNarratives.map((entry) => `R${entry.round} · ${entry.text}`),
    missingInformation: state.missingInformation,
  };
}
