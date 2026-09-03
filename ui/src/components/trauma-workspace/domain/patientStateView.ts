import type { CaseState } from './types';

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
    certainty: '已确认' | '疑似' | '已排除';
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

export function derivePatientStateView(state: CaseState): PatientStateView {
  const current = state.vitalSignsHistory.at(-1);
  const previous = state.vitalSignsHistory.at(-2);
  const vitals: PatientStateView['vitals'] = [];
  if (current?.respiratoryRate !== undefined) {
    vitals.push({
      label: '呼吸',
      value: `${current.respiratoryRate} 次/分`,
      trend: trend(current.respiratoryRate, previous?.respiratoryRate),
      abnormal: current.respiratoryRate > 20,
    });
  }
  if (current?.systolicBloodPressure !== undefined) {
    vitals.push({
      label: '收缩压',
      value: `${current.systolicBloodPressure} mmHg`,
      trend: trend(current.systolicBloodPressure, previous?.systolicBloodPressure),
      abnormal: current.systolicBloodPressure < 90,
    });
  }
  if (current?.heartRate !== undefined) {
    vitals.push({
      label: '心率',
      value: `${current.heartRate} 次/分`,
      trend: trend(current.heartRate, previous?.heartRate),
      abnormal: current.heartRate > 100,
    });
  }
  if (current?.spo2 !== undefined) {
    vitals.push({
      label: 'SpO₂',
      value: `${current.spo2}%`,
      trend: trend(current.spo2, previous?.spo2),
      abnormal: current.spo2 < 94,
    });
  }

  const certainty = {
    confirmed: '已确认',
    suspected: '疑似',
    excluded: '已排除',
  } as const;

  return {
    updatedAt: new Date(state.updatedAt).toLocaleString(),
    consciousness: current?.gcs !== undefined ? `GCS ${current.gcs}` : '尚未记录',
    vitals,
    injuries: state.injuries.map((injury) => ({
      label: `${injury.bodyPart} · ${injury.finding}`,
      certainty: certainty[injury.certainty],
      status: injury.status,
    })),
    treatments: state.completedActions.map((action) => action.title),
    missingInformation: state.missingInformation,
  };
}
