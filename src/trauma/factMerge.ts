import type {
  CaseState,
  NarrativeEntry,
  TurnFormInput,
  VitalItemKey,
} from "./types.js";

const VITAL_RANGES: Record<VitalItemKey, readonly [number, number]> = {
  respiratoryRate: [0, 80],
  systolicBloodPressure: [20, 300],
  gcs: [3, 15],
  heartRate: [0, 300],
  temperature: [20, 45],
  spo2: [0, 100],
};

const TEXT_LIMITS = {
  injuryNarrative: 1_000,
  treatmentNarrative: 800,
  evacuationNarrative: 500,
  note: 500,
} as const;

const FORM_SUBSTAGES = new Set([
  "primary_first_aid",
  "advanced_first_aid",
  "emergency_treatment",
  "surgical_resuscitation",
]);

export function validateTurnFormInput(value: unknown): value is TurnFormInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(["statedSubStage", ...Object.keys(TEXT_LIMITS), "vitals"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return false;
  if (!("statedSubStage" in input)) return false;
  if (input.statedSubStage !== null && !FORM_SUBSTAGES.has(String(input.statedSubStage))) {
    return false;
  }

  const hasNarrative = Object.keys(TEXT_LIMITS).some((key) => {
    const text = input[key];
    return typeof text === "string" && text.trim().length > 0;
  });
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
    const text = input[key];
    if (typeof text !== "string" || text.length > limit) return false;
  }

  const vitals = input.vitals;
  if (!vitals || typeof vitals !== "object" || Array.isArray(vitals)) return false;
  let hasVital = false;
  for (const [key, raw] of Object.entries(vitals)) {
    if (!(key in VITAL_RANGES) || typeof raw !== "number" || !Number.isFinite(raw)) return false;
    const vitalKey = key as VitalItemKey;
    const [minimum, maximum] = VITAL_RANGES[vitalKey];
    if (raw < minimum || raw > maximum) return false;
    if (vitalKey === "temperature") {
      if (!Number.isInteger(raw * 10)) return false;
    } else if (!Number.isInteger(raw)) {
      return false;
    }
    hasVital = true;
  }
  return hasNarrative || hasVital;
}

function appendNarrative(
  entries: NarrativeEntry[],
  text: string,
  round: number,
  createdAt: string,
): void {
  const trimmed = text.trim();
  if (trimmed) entries.push({ round, createdAt, text: trimmed });
}

export function mergeFormInput(
  previous: CaseState,
  input: TurnFormInput,
  round: number,
  now: string,
): CaseState {
  const state = structuredClone(previous);
  state.updatedAt = now;
  appendNarrative(state.injuryNarratives, input.injuryNarrative, round, now);
  appendNarrative(state.treatmentNarratives, input.treatmentNarrative, round, now);
  appendNarrative(state.evacuationNarratives, input.evacuationNarrative, round, now);
  appendNarrative(state.notes, input.note, round, now);
  if (Object.keys(input.vitals).length > 0) {
    state.vitalSignsHistory.push({
      round,
      recordedAt: now,
      values: { ...input.vitals },
    });
  }
  return state;
}

function recentNarratives(entries: NarrativeEntry[]): NarrativeEntry[] {
  return entries
    .slice()
    .sort((left, right) => right.round - left.round)
    .slice(0, 6)
    .map((entry) => ({ ...entry, text: entry.text.slice(0, 300) }));
}

export function compactCaseStateForDownstream(state: CaseState) {
  const latestVitals = state.vitalSignsHistory.at(-1);
  const recentVitalRecords = state.vitalSignsHistory
    .slice(-6)
    .reverse()
    .map((record) => ({
      ...record,
      values: { ...record.values },
    }));
  const latestByField: Partial<Record<
    VitalItemKey,
    { value: number; round: number; stale: boolean }
  >> = {};
  const latestValues: Partial<Record<VitalItemKey, number>> = {};
  const vitalKeys = Object.keys(VITAL_RANGES) as VitalItemKey[];
  for (let index = state.vitalSignsHistory.length - 1; index >= 0; index -= 1) {
    const record = state.vitalSignsHistory[index];
    if (!record) continue;
    for (const key of vitalKeys) {
      const value = record.values[key];
      if (value === undefined || latestByField[key]) continue;
      latestByField[key] = {
        value,
        round: record.round,
        stale: record.round !== state.round,
      };
      latestValues[key] = value;
    }
  }
  let latestNote: NarrativeEntry | null = null;
  for (let index = state.notes.length - 1; index >= 0; index -= 1) {
    if (state.notes[index]?.round === state.round) {
      latestNote = state.notes[index] ?? null;
      break;
    }
  }
  return {
    currentStage: state.currentStage,
    currentSubStage: state.currentSubStage,
    facility: state.currentFacility,
    injuryNarratives: recentNarratives(state.injuryNarratives),
    treatmentNarratives: recentNarratives(state.treatmentNarratives),
    evacuationNarratives: recentNarratives(state.evacuationNarratives),
    note: latestNote,
    vitals: {
      recentRecords: recentVitalRecords,
      latestByField,
      latestMeasuredRound: latestVitals?.round ?? null,
      measuredThisRound: latestVitals?.round === state.round,
      values: latestValues,
    },
  };
}
