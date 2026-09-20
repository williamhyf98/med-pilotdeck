/**
 * Case State（战创伤单病例状态）的只读读取接口。
 *
 * 术语（§2.1）：Case State 是病例流程的**权威数据**，和 Long-term Memory 是两
 * 回事；Task 8 把索引诊断记录搬去 `/index-case-traces` 之后，`cases` 这个词才
 * 还给了这里。
 *
 * **只读**：这里只有 GET。病例的修改必须走 Trauma 专用业务接口（推演回合、
 * 阶段确认、人工覆盖），那条路径会写 snapshots、维护 version/round。把 Case
 * State 做成可自由编辑的 Markdown memory 会直接破坏病例的可追溯性。
 *
 * 定位路径与 `createLocalGateway.ts` 的 `readTraumaCase` 一致：projectId 决定
 * typed memory 目录，`cases/<caseDirSlug>` 决定 session 子目录，读 `current.json`
 * 与 `snapshots.jsonl`。UI 服务端不能依赖 TS 产物，所以这里按 §2.2 的 resolver
 * 重走同一套路径，而不是就地推导。
 */
import express from 'express';
import fs from 'fs/promises';
import path from 'path';

import { isWarTraumaScope, resolveMemoryScopeIdentity } from '../utils/memoryIdentity.js';
import { resolvePilotHome, resolveTypedProjectMemoryDir } from '../utils/pilotPaths.js';

const router = express.Router();

const DEFAULT_SNAPSHOT_LIMIT = 50;
const VITAL_KEYS = [
  'respiratoryRate', 'systolicBloodPressure', 'heartRate', 'temperature', 'spo2',
  // 兼容早期病例文件。
  'rr', 'sbp', 'hr',
];

function readField(req, field) {
  const value = req.query?.[field] ?? req.body?.[field];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 同一个 session 在磁盘上可能是原始 id 也可能是清洗后的 slug（§2.2 要求对每个
 * slug 做 raw/sanitized 双探测），两个都要探。
 */
function probeNames(slug, rawSessionId) {
  return Array.from(new Set([slug, rawSessionId].filter(Boolean)));
}

async function resolveCaseDir(identity, pilotHome) {
  const casesRoot = path.join(resolveTypedProjectMemoryDir(identity.projectId, pilotHome), 'cases');
  for (const name of probeNames(identity.caseDirSlug, identity.sessionId)) {
    const candidate = path.join(casesRoot, name);
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // keep probing
    }
  }
  return null;
}

function lastOf(value) {
  return Array.isArray(value) && value.length > 0 ? value[value.length - 1] : null;
}

function summarizeNarratives(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const latest = lastOf(list);
  return {
    count: list.length,
    latestRound: latest?.round ?? null,
    latestText: typeof latest?.text === 'string' ? latest.text : '',
  };
}

/**
 * `current.json` 的展示摘要。
 *
 * 只挑面板要显示的字段，刻意不跑 `migrateCaseState`——迁移是写路径的权威逻辑，
 * 在只读视图里复刻一份就等于多了一个会漂移的副本。代价是：叙述性字段出现之前
 * 写下的存量病例，这里的 narratives 计数会是 0，而阶段、生命体征、后送状态照常
 * 显示。
 */
export function summarizeCaseState(state) {
  if (!state || typeof state !== 'object') return null;
  const classification = lastOf(state.classificationHistory);
  const vitals = lastOf(state.vitalSignsHistory);
  return {
    caseId: state.caseId ?? null,
    sessionId: state.sessionId ?? null,
    projectId: state.projectId ?? null,
    version: state.version ?? null,
    round: state.round ?? null,
    updatedAt: state.updatedAt ?? null,
    stage: { main: state.currentStage ?? null, sub: state.currentSubStage ?? null },
    placementRationale: state.placementRationale ?? '',
    facility: state.currentFacility
      ? {
        name: state.currentFacility.name ?? '',
        type: state.currentFacility.type ?? '',
        capabilities: Array.isArray(state.currentFacility.capabilities)
          ? state.currentFacility.capabilities
          : [],
      }
      : null,
    classification: classification
      ? {
        severity: classification.severity ?? 'unknown',
        treatmentPriority: classification.treatmentPriority ?? 'pending',
        transportPriority: classification.transportPriority ?? 'pending',
        createdAt: classification.createdAt ?? null,
        rationale: Array.isArray(classification.rationale) ? classification.rationale : [],
      }
      : null,
    vitals: vitals
      ? {
        round: vitals.round ?? null,
        recordedAt: vitals.recordedAt ?? null,
        values: vitals.values && typeof vitals.values === 'object' ? vitals.values : {},
      }
      : null,
    transport: {
      needed: Boolean(state.transport?.needed),
      priority: state.transport?.priority ?? 'pending',
      readiness: state.transport?.readiness ?? 'unknown',
      gateStatus: state.transport?.gateStatus ?? null,
      blockingReason: state.transport?.blockingReason ?? '',
    },
    narratives: {
      injury: summarizeNarratives(state.injuryNarratives),
      treatment: summarizeNarratives(state.treatmentNarratives),
      evacuation: summarizeNarratives(state.evacuationNarratives),
      note: summarizeNarratives(state.notes),
    },
    missingInformation: Array.isArray(state.missingInformation) ? state.missingInformation : [],
    pendingTransition: state.pendingTransition ?? null,
    counts: {
      evidence: Array.isArray(state.evidence) ? state.evidence.length : 0,
      memos: Array.isArray(state.memos) ? state.memos.length : 0,
      vitalRounds: Array.isArray(state.vitalSignsHistory) ? state.vitalSignsHistory.length : 0,
    },
  };
}

export function summarizeSnapshot(snapshot) {
  const state = snapshot?.state ?? {};
  const classification = lastOf(state.classificationHistory);
  return {
    eventType: snapshot?.eventType ?? null,
    round: snapshot?.round ?? null,
    createdAt: snapshot?.createdAt ?? null,
    triggerMessageId: snapshot?.triggerMessageId ?? null,
    version: state.version ?? null,
    stage: { main: state.currentStage ?? null, sub: state.currentSubStage ?? null },
    facilityName: state.currentFacility?.name ?? '',
    severity: classification?.severity ?? null,
    transportPriority: state.transport?.priority ?? null,
  };
}

function recentNarratives(entries) {
  return (Array.isArray(entries) ? entries : [])
    .slice()
    .sort((left, right) => Number(right?.round ?? 0) - Number(left?.round ?? 0))
    .slice(0, 6)
    .map((entry) => ({
      round: entry?.round ?? null,
      createdAt: entry?.createdAt ?? null,
      text: typeof entry?.text === 'string' ? entry.text.slice(0, 300) : '',
    }));
}

/** 与 runner 的 compactCaseStateForDownstream 保持同一展示语义。 */
export function summarizeRunnerContext(state) {
  const vitalHistory = Array.isArray(state?.vitalSignsHistory) ? state.vitalSignsHistory : [];
  const recentRecords = vitalHistory.slice(-6).reverse().map((record) => ({
    round: record?.round ?? null,
    recordedAt: record?.recordedAt ?? null,
    values: Object.fromEntries(VITAL_KEYS.flatMap((key) => (
      record?.values?.[key] === undefined ? [] : [[key, record.values[key]]]
    ))),
  }));
  const latestByField = {};
  const values = {};
  for (let index = vitalHistory.length - 1; index >= 0; index -= 1) {
    const record = vitalHistory[index];
    for (const key of VITAL_KEYS) {
      const value = record?.values?.[key];
      if (value === undefined || latestByField[key]) continue;
      latestByField[key] = { value, round: record?.round ?? null, stale: record?.round !== state?.round };
      values[key] = value;
    }
  }
  const notes = Array.isArray(state?.notes) ? state.notes : [];
  const note = notes.slice().reverse().find((entry) => entry?.round === state?.round) ?? null;
  const latestVitals = vitalHistory.at(-1);
  return {
    currentStage: state?.currentStage ?? null,
    currentSubStage: state?.currentSubStage ?? null,
    facility: state?.currentFacility
      ? {
        name: state.currentFacility.name ?? '',
        type: state.currentFacility.type ?? '',
        capabilities: Array.isArray(state.currentFacility.capabilities)
          ? state.currentFacility.capabilities
          : [],
      }
      : null,
    injuryNarratives: recentNarratives(state?.injuryNarratives),
    treatmentNarratives: recentNarratives(state?.treatmentNarratives),
    evacuationNarratives: recentNarratives(state?.evacuationNarratives),
    note: note
      ? { round: note.round ?? null, createdAt: note.createdAt ?? null, text: note.text ?? '' }
      : null,
    vitals: {
      recentRecords,
      latestByField,
      latestMeasuredRound: latestVitals?.round ?? null,
      measuredThisRound: latestVitals?.round === state?.round,
      values,
    },
  };
}

export function summarizeRound(snapshot) {
  if (snapshot?.eventType !== 'agent_turn') return null;
  const state = snapshot?.state ?? {};
  const response = snapshot?.response ?? {};
  const classification = response.classification ?? lastOf(state.classificationHistory);
  const currentInterpretation = (Array.isArray(state.attachmentInterpretations)
    ? state.attachmentInterpretations
    : []).slice().reverse().find((entry) => entry?.round === snapshot.round);
  return {
    round: snapshot.round ?? state.round ?? null,
    version: state.version ?? null,
    createdAt: snapshot.createdAt ?? state.updatedAt ?? null,
    triggerMessageId: snapshot.triggerMessageId ?? null,
    context: summarizeRunnerContext(state),
    input: {
      rawInput: typeof snapshot.rawInput === 'string' ? snapshot.rawInput : '',
      statedSubStage: snapshot.form?.statedSubStage ?? null,
      injuryNarrative: snapshot.form?.injuryNarrative ?? '',
      treatmentNarrative: snapshot.form?.treatmentNarrative ?? '',
      evacuationNarrative: snapshot.form?.evacuationNarrative ?? '',
      note: snapshot.form?.note ?? '',
      vitals: snapshot.form?.vitals && typeof snapshot.form.vitals === 'object'
        ? snapshot.form.vitals
        : {},
      attachmentInterpretation: currentInterpretation?.text ?? '',
    },
    result: {
      classification: classification
        ? {
          severity: classification.severity ?? 'unknown',
          treatmentPriority: classification.treatmentPriority ?? 'pending',
          transportPriority: classification.transportPriority ?? 'pending',
          rationale: Array.isArray(classification.rationale) ? classification.rationale : [],
        }
        : null,
      treatmentPlan: Array.isArray(response.treatmentPlan) ? response.treatmentPlan.map((item) => ({
        title: item?.title ?? '',
        description: item?.description ?? '',
        scope: item?.scope ?? null,
      })) : [],
      transition: response.transition
        ? {
          status: response.transition.status ?? state.transport?.gateStatus ?? null,
          targetStage: response.transition.targetStage ?? null,
          targetSubStage: response.transition.targetSubStage ?? null,
          reason: response.transition.reason ?? '',
        }
        : null,
      memo: response.memo
        ? {
          title: response.memo.title ?? '',
          inputPoints: Array.isArray(response.memo.inputPoints) ? response.memo.inputPoints : [],
          actionPoints: Array.isArray(response.memo.actionPoints) ? response.memo.actionPoints : [],
          conclusion: response.memo.conclusion ?? '',
        }
        : null,
      missingInformation: Array.isArray(response.missingInformation)
        ? response.missingInformation
        : Array.isArray(state.missingInformation) ? state.missingInformation : [],
      transport: {
        needed: Boolean(state.transport?.needed),
        priority: state.transport?.priority ?? 'pending',
        readiness: state.transport?.readiness ?? 'unknown',
        gateStatus: state.transport?.gateStatus ?? null,
        blockingReason: state.transport?.blockingReason ?? '',
      },
      requiredCapabilities: Array.isArray(state.requiredCapabilities) ? state.requiredCapabilities : [],
    },
  };
}

async function readCurrent(caseDir) {
  try {
    return { state: JSON.parse(await fs.readFile(path.join(caseDir, 'current.json'), 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: null };
    // 文件在但读不出来是真问题，不能伪装成「还没有病例」。
    return { state: null, unreadable: error instanceof Error ? error.message : String(error) };
  }
}

async function readSnapshots(caseDir, limit) {
  let raw;
  try {
    raw = await fs.readFile(path.join(caseDir, 'snapshots.jsonl'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { snapshots: [], total: 0 };
    return { snapshots: [], total: 0, unreadable: error instanceof Error ? error.message : String(error) };
  }

  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const parsed = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // 一行坏了不该让整条时间线消失；计数后继续。
      skipped += 1;
    }
  }
  // 最新的在前：时间线是倒序看的。
  parsed.reverse();
  const selected = parsed.slice(0, limit);
  const rounds = selected.map(summarizeRound).filter(Boolean).map((round) => ({
    ...round,
    events: selected
      .filter((snapshot) => snapshot?.eventType !== 'agent_turn' && snapshot?.round === round.round)
      .map(summarizeSnapshot),
  }));
  return {
    snapshots: selected.map(summarizeSnapshot),
    rounds,
    total: parsed.length,
    skipped,
  };
}

/**
 * 解析请求的病例作用域。返回 null 表示已经回过响应。
 */
function resolveScope(req, res) {
  const projectKey = readField(req, 'projectId') || readField(req, 'projectPath');
  const sessionId = readField(req, 'sessionId');
  if (!projectKey) {
    res.status(400).json({ error: 'projectId is required' });
    return null;
  }
  if (!sessionId) {
    // 没有 session 就没有病例可言——Case State 是 per-session 的。
    res.status(400).json({ error: 'sessionId is required' });
    return null;
  }

  const pilotHome = resolvePilotHome(process.env);
  const identity = resolveMemoryScopeIdentity({ projectKey, pilotHome, sessionId });
  if (!isWarTraumaScope(identity)) {
    // 通用医学项目根本没有 cases/ 目录，这不是错误状态而是「不适用」。
    res.status(404).json({
      error: 'Case State only exists for war_trauma projects',
      code: 'CASE_STATE_UNSUPPORTED',
      projectType: identity.projectType,
    });
    return null;
  }
  return { identity, pilotHome };
}

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

router.get('/current', async (req, res) => {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const { identity, pilotHome } = scope;

  try {
    const caseDir = await resolveCaseDir(identity, pilotHome);
    if (!caseDir) {
      return res.json({
        readOnly: true,
        projectId: identity.projectId,
        projectType: identity.projectType,
        sessionId: identity.sessionId,
        caseDir: null,
        current: null,
      });
    }
    const { state, unreadable } = await readCurrent(caseDir);
    res.json({
      readOnly: true,
      projectId: identity.projectId,
      projectType: identity.projectType,
      sessionId: identity.sessionId,
      caseDir,
      current: summarizeCaseState(state),
      ...(unreadable ? { unreadable } : {}),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/snapshots', async (req, res) => {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const { identity, pilotHome } = scope;

  try {
    const caseDir = await resolveCaseDir(identity, pilotHome);
    if (!caseDir) {
      return res.json({ readOnly: true, sessionId: identity.sessionId, snapshots: [], total: 0 });
    }
    const result = await readSnapshots(caseDir, parseLimit(req.query.limit, DEFAULT_SNAPSHOT_LIMIT));
    res.json({ readOnly: true, sessionId: identity.sessionId, ...result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
