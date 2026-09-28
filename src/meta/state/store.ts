/**
 * 评价状态的持久化。写法照 src/trauma/store.ts：
 *   - current.json 原子写（临时文件 + rename），中途断电不会留半个文件；
 *   - snapshots.jsonl 每轮追加一条，供回放与审计；
 *   - 读取时校验 schemaVersion，不认的结构直接抛错，不当成空状态继续。
 *
 * 最后一条很重要：把无法识别的状态当成空状态，会导致"看起来跑完了，
 * 其实把之前的结论全丢了"，而且不留痕迹。宁可报错。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  REVIEW_STATE_SCHEMA_VERSION,
  type ReviewState,
} from "./types.js";

export type SnapshotKind = "pipeline_run" | "human_override" | "criteria_relock";

export type Snapshot = {
  at: string;
  version: number;
  round: number;
  kind: SnapshotKind;
  state: ReviewState;
};

export function reviewDir(root: string, reviewId: string): string {
  return join(root, reviewId);
}

export function currentFile(root: string, reviewId: string): string {
  return join(reviewDir(root, reviewId), "current.json");
}

export function snapshotsFile(root: string, reviewId: string): string {
  return join(reviewDir(root, reviewId), "snapshots.jsonl");
}

export function auditFile(root: string, reviewId: string): string {
  return join(reviewDir(root, reviewId), "audit.jsonl");
}

export async function loadReviewState(
  root: string,
  reviewId: string,
): Promise<ReviewState | null> {
  let raw: string;
  try {
    raw = await readFile(currentFile(root, reviewId), "utf8");
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`review state for ${reviewId} is not an object`);
  }
  const state = parsed as ReviewState;
  if (state.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) {
    throw new Error(
      `review state for ${reviewId} has schemaVersion ${state.schemaVersion}, `
      + `expected ${REVIEW_STATE_SCHEMA_VERSION}`,
    );
  }
  if (state.reviewId !== reviewId) {
    throw new Error(`review state file for ${reviewId} contains ${state.reviewId}`);
  }
  if (typeof state.items !== "object" || state.items === null) {
    throw new Error(`review state for ${reviewId} has no items map`);
  }
  return state;
}

/** 原子写：先写临时文件再 rename，避免读到半个 JSON。 */
async function writeAtomic(file: string, body: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, body, "utf8");
  await rename(temporary, file);
}

export async function saveReviewState(
  root: string,
  state: ReviewState,
  kind: SnapshotKind = "pipeline_run",
): Promise<ReviewState> {
  const next: ReviewState = {
    ...state,
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
  await writeAtomic(currentFile(root, next.reviewId), `${JSON.stringify(next, null, 2)}\n`);
  const snapshot: Snapshot = {
    at: next.updatedAt,
    version: next.version,
    round: next.round,
    kind,
    state: next,
  };
  await appendFile(snapshotsFile(root, next.reviewId), `${JSON.stringify(snapshot)}\n`, "utf8");
  return next;
}

// ---- 审计日志 --------------------------------------------------------------

export type AuditEvent = {
  at: string;
  reviewId: string;
  round: number;
  step: string;
  phase: "started" | "completed" | "failed" | "skipped";
  detail?: Record<string, unknown>;
};

export type AuditLog = {
  record(event: Omit<AuditEvent, "at">): Promise<void>;
};

export function createAuditLog(root: string, reviewId: string): AuditLog {
  const file = auditFile(root, reviewId);
  return {
    async record(event) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...event });
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${line}\n`, "utf8");
    },
  };
}

/** 不落盘的审计日志，测试与 dry-run 用。 */
export function createMemoryAuditLog(): AuditLog & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    async record(event) {
      events.push({ at: new Date().toISOString(), ...event });
    },
  };
}
