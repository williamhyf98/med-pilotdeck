import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CaseSnapshot, CaseState } from "./types.js";

export type TraumaCaseStore = {
  load(): Promise<CaseState | null>;
  loadSnapshots(): Promise<CaseSnapshot[]>;
  saveTurn(state: CaseState, snapshot: CaseSnapshot): Promise<void>;
};

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createTraumaCaseStore(directory: string): TraumaCaseStore {
  const currentPath = join(directory, "current.json");
  const snapshotsPath = join(directory, "snapshots.jsonl");

  return {
    async load(): Promise<CaseState | null> {
      try {
        return JSON.parse(await readFile(currentPath, "utf8")) as CaseState;
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
        return lines.map((line) => JSON.parse(line) as CaseSnapshot);
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
