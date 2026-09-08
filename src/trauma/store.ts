import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { typicalFacilityForSubStage } from "./stageConfig.js";
import type { CaseSnapshot, CaseState, VitalItemKey } from "./types.js";

export type TraumaCaseStore = {
  load(): Promise<CaseState | null>;
  loadSnapshots(): Promise<CaseSnapshot[]>;
  saveTurn(state: CaseState, snapshot: CaseSnapshot): Promise<void>;
};

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VITAL_KEYS = [
  "respiratoryRate",
  "systolicBloodPressure",
  "gcs",
  "heartRate",
  "temperature",
] as const satisfies readonly VitalItemKey[];

export function migrateCaseState(value: unknown): CaseState {
  if (!isRecord(value)) throw new Error("trauma case migration failed: state is not an object");
  for (const key of ["caseId", "sessionId", "projectId", "updatedAt"]) {
    if (typeof value[key] !== "string") {
      throw new Error(`trauma case migration failed: invalid ${key}`);
    }
  }
  if (!Number.isInteger(value.version) || !Number.isInteger(value.round)) {
    throw new Error("trauma case migration failed: invalid version or round");
  }

  const state = structuredClone(value);
  const toNarrative = (key: string, legacyKey: string, render: (item: Record<string, unknown>) => string) => {
    if (Array.isArray(state[key])) return;
    const legacy = state[legacyKey];
    if (legacy === undefined) {
      state[key] = [];
      return;
    }
    if (!Array.isArray(legacy) || !legacy.every(isRecord)) {
      throw new Error(`trauma case migration failed: invalid ${legacyKey}`);
    }
    const text = legacy.map(render).filter(Boolean).join("；");
    state[key] = text ? [{ round: 0, createdAt: state.updatedAt, text }] : [];
  };

  toNarrative("injuryNarratives", "injuries", (item) => {
    const body = typeof item.bodyPart === "string" ? item.bodyPart : "";
    const finding = typeof item.finding === "string" ? item.finding : "";
    if (!body && !finding) throw new Error("trauma case migration failed: invalid injury");
    const certainty = typeof item.certainty === "string" ? `，${item.certainty}` : "";
    const status = typeof item.status === "string" ? `，${item.status}` : "";
    return `迁移自结构化伤情：${body}${finding}${certainty}${status}`;
  });

  if (!Array.isArray(state.treatmentNarratives)) {
    const actions = [state.completedActions, state.currentActions]
      .flatMap((items) => items === undefined ? [] : Array.isArray(items) ? items : [items]);
    if (!actions.every(isRecord)) {
      throw new Error("trauma case migration failed: invalid treatment actions");
    }
    const text = actions.map((item) => {
      if (typeof item.title !== "string") {
        throw new Error("trauma case migration failed: invalid treatment action");
      }
      return item.title;
    }).join("；");
    state.treatmentNarratives = text
      ? [{ round: 0, createdAt: state.updatedAt, text: `迁移自结构化处置：${text}` }]
      : [];
  }
  for (const key of ["evacuationNarratives", "notes"]) {
    if (state[key] === undefined) state[key] = [];
    if (!Array.isArray(state[key])) throw new Error(`trauma case migration failed: invalid ${key}`);
  }

  if (!Array.isArray(state.vitalSignsHistory)) {
    throw new Error("trauma case migration failed: invalid vitalSignsHistory");
  }
  state.vitalSignsHistory = state.vitalSignsHistory.map((item, index) => {
    if (!isRecord(item)) throw new Error("trauma case migration failed: invalid vital record");
    if (isRecord(item.values) && Number.isInteger(item.round) && typeof item.recordedAt === "string") {
      return item;
    }
    const values: Record<string, number> = {};
    for (const key of VITAL_KEYS) {
      if (typeof item[key] === "number" && Number.isFinite(item[key])) values[key] = item[key];
    }
    return {
      round: index + 1,
      recordedAt: typeof item.measuredAt === "string" ? item.measuredAt : state.updatedAt,
      values,
      _migrationOrder: index,
    };
  }).map(({ _migrationOrder: _ignored, ...item }) => item);

  if (state.currentSubStage) {
    const facility = typicalFacilityForSubStage(state.currentSubStage as CaseState["currentSubStage"] & string);
    state.currentFacility = facility;
    state.currentCapabilities = [...facility.capabilities];
  }

  for (const key of [
    "injuries",
    "completedActions",
    "currentActions",
    "timeline",
    "conflictingFactIds",
  ]) delete state[key];

  const requiredArrays = [
    "injuryNarratives", "treatmentNarratives", "evacuationNarratives", "notes",
    "vitalSignsHistory", "requiredCapabilities", "currentCapabilities",
    "classificationHistory", "manualStageOverrides", "evidence", "memos", "missingInformation",
  ];
  if (requiredArrays.some((key) => !Array.isArray(state[key])) || !isRecord(state.transport)) {
    throw new Error("trauma case migration failed: unrecognized state structure");
  }
  return state as CaseState;
}

export function createTraumaCaseStore(directory: string): TraumaCaseStore {
  const currentPath = join(directory, "current.json");
  const snapshotsPath = join(directory, "snapshots.jsonl");

  return {
    async load(): Promise<CaseState | null> {
      try {
        return migrateCaseState(JSON.parse(await readFile(currentPath, "utf8")));
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },

    async loadSnapshots(): Promise<CaseSnapshot[]> {
      try {
        const lines = (await readFile(snapshotsPath, "utf8"))
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        return lines.map((line) => {
          const snapshot = JSON.parse(line) as Record<string, unknown>;
          if (!isRecord(snapshot) || !("state" in snapshot)) {
            throw new Error("trauma case migration failed: invalid snapshot");
          }
          return { ...snapshot, state: migrateCaseState(snapshot.state) } as CaseSnapshot;
        });
      } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
      }
    },

    async saveTurn(state: CaseState, snapshot: CaseSnapshot): Promise<void> {
      const currentJson = `${JSON.stringify(state, null, 2)}\n`;
      const snapshotLine = `${JSON.stringify(snapshot)}\n`;
      await mkdir(directory, { recursive: true });

      const temporaryPath = `${currentPath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(temporaryPath, currentJson, "utf8");
        await appendFile(snapshotsPath, snapshotLine, "utf8");
        await rename(temporaryPath, currentPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
  };
}
