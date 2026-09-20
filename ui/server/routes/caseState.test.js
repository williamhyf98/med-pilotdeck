/**
 * Task 9 —— Case State 只读接口。
 *
 * 用真实临时 PILOT_HOME 落盘：这条路径的全部风险都在「目录到底解析到哪」，
 * 把 resolver 桩掉就等于不测。
 */
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import caseStateRoutes from './caseState.js';

let PILOT_HOME = '';
let server;
let baseUrl = '';

const TRAUMA_PROJECT = 'trauma_med-abc123';
const GENERAL_PROJECT = 'general_med-xyz789';

function caseDirFor(projectId, dirName) {
  const typeKey = projectId.startsWith('trauma_med') ? 'trauma_med' : 'general_med';
  return path.join(PILOT_HOME, 'memory', typeKey, projectId, 'cases', dirName);
}

function seedCase(projectId, dirName, { current, snapshots } = {}) {
  const dir = caseDirFor(projectId, dirName);
  fs.mkdirSync(dir, { recursive: true });
  if (current !== undefined) {
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(current), 'utf8');
  }
  if (snapshots !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'snapshots.jsonl'),
      snapshots.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join('\n'),
      'utf8',
    );
  }
  return dir;
}

function fullCaseState() {
  return {
    caseId: 'case-1',
    sessionId: 'web:s1',
    projectId: TRAUMA_PROJECT,
    version: 7,
    round: 3,
    updatedAt: '2026-09-16T10:00:00.000Z',
    currentStage: 'role2',
    currentSubStage: 'damage_control',
    currentFacility: { name: '二级救治机构', type: 'role2', capabilities: ['surgery'] },
    classificationHistory: [
      { severity: 'moderate', treatmentPriority: 'delayed', createdAt: '2026-09-16T09:00:00.000Z' },
      {
        severity: 'severe',
        treatmentPriority: 'immediate',
        transportPriority: 'urgent',
        createdAt: '2026-09-16T10:00:00.000Z',
        rationale: ['失血性休克'],
      },
    ],
    vitalSignsHistory: [
      { round: 1, recordedAt: '2026-09-16T09:00:00.000Z', values: { hr: 90 } },
      { round: 3, recordedAt: '2026-09-16T10:00:00.000Z', values: { hr: 128, sbp: 82 } },
    ],
    transport: { needed: true, priority: 'urgent', readiness: 'ready', gateStatus: 'open' },
    injuryNarratives: [
      { round: 1, text: '左大腿贯通伤' },
      { round: 3, text: '左大腿贯通伤伴活动性出血' },
    ],
    treatmentNarratives: [{ round: 2, text: '止血带' }],
    missingInformation: ['受伤时间'],
    evidence: [{ id: 'e1' }],
    memos: [],
  };
}

async function request(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  PILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-case-'));
  process.env.PILOT_HOME = PILOT_HOME;

  const app = express();
  app.use('/cases', caseStateRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(PILOT_HOME, { recursive: true, force: true });
  delete process.env.PILOT_HOME;
});

describe('GET /cases/current', () => {
  it('摘要战创伤病例的当前状态', async () => {
    seedCase(TRAUMA_PROJECT, 'web_s1', { current: fullCaseState() });

    const { status, body } = await request(
      `/cases/current?projectId=${TRAUMA_PROJECT}&sessionId=web:s1`,
    );

    expect(status).toBe(200);
    expect(body.current.caseId).toBe('case-1');
    expect(body.current.version).toBe(7);
    expect(body.current.round).toBe(3);
    expect(body.current.stage).toEqual({ main: 'role2', sub: 'damage_control' });
    expect(body.current.facility.name).toBe('二级救治机构');
    // 分类与生命体征都取最后一条，而不是第一条。
    expect(body.current.classification.severity).toBe('severe');
    expect(body.current.vitals.values).toEqual({ hr: 128, sbp: 82 });
    expect(body.current.transport).toMatchObject({ needed: true, priority: 'urgent' });
    expect(body.current.narratives.injury).toMatchObject({
      count: 2,
      latestRound: 3,
      latestText: '左大腿贯通伤伴活动性出血',
    });
    expect(body.current.missingInformation).toEqual(['受伤时间']);
    expect(body.current.counts).toEqual({ evidence: 1, memos: 0, vitalRounds: 2 });
  });

  it('响应始终标注只读——编辑走 Trauma 业务接口', async () => {
    seedCase(TRAUMA_PROJECT, 'web_s1', { current: fullCaseState() });

    const { body } = await request(`/cases/current?projectId=${TRAUMA_PROJECT}&sessionId=web:s1`);

    expect(body.readOnly).toBe(true);
  });

  it('通用医学项目返回 404 CASE_STATE_UNSUPPORTED', async () => {
    const { status, body } = await request(
      `/cases/current?projectId=${GENERAL_PROJECT}&sessionId=web:s1`,
    );

    expect(status).toBe(404);
    expect(body.code).toBe('CASE_STATE_UNSUPPORTED');
    expect(body.projectType).toBe('general_medicine');
  });

  it('缺 sessionId 时 400——病例状态是 per-session 的', async () => {
    const { status, body } = await request(`/cases/current?projectId=${TRAUMA_PROJECT}`);

    expect(status).toBe(400);
    expect(body.error).toMatch(/sessionId/u);
  });

  it('缺 projectId 时 400', async () => {
    const { status } = await request('/cases/current?sessionId=web:s1');
    expect(status).toBe(400);
  });

  it('尚未产生病例时返回 current: null 而不是报错', async () => {
    const { status, body } = await request(
      `/cases/current?projectId=${TRAUMA_PROJECT}&sessionId=web:s1`,
    );

    expect(status).toBe(200);
    expect(body.current).toBeNull();
    expect(body.caseDir).toBeNull();
  });

  it('目录存在但 current.json 缺失时同样返回 null', async () => {
    seedCase(TRAUMA_PROJECT, 'web_s1', {});

    const { body } = await request(`/cases/current?projectId=${TRAUMA_PROJECT}&sessionId=web:s1`);

    expect(body.current).toBeNull();
    expect(body.caseDir).not.toBeNull();
  });

  it('按未清洗的原始 session id 落盘的目录也能找到', async () => {
    // 历史数据里存在直接用 raw id 建的目录，双探测必须覆盖。
    seedCase(TRAUMA_PROJECT, 'web:s1', { current: fullCaseState() });

    const { body } = await request(`/cases/current?projectId=${TRAUMA_PROJECT}&sessionId=web:s1`);

    expect(body.current.caseId).toBe('case-1');
  });

  it('缺少叙述性字段的旧病例给出部分数据而不是崩掉', async () => {
    seedCase(TRAUMA_PROJECT, 'web_s1', {
      current: { caseId: 'legacy', version: 1, round: 1, currentStage: 'role1' },
    });

    const { status, body } = await request(
      `/cases/current?projectId=${TRAUMA_PROJECT}&sessionId=web:s1`,
    );

    expect(status).toBe(200);
    expect(body.current.caseId).toBe('legacy');
    expect(body.current.narratives.injury.count).toBe(0);
    expect(body.current.classification).toBeNull();
    expect(body.current.vitals).toBeNull();
    expect(body.current.transport.needed).toBe(false);
  });
});

describe('GET /cases/snapshots', () => {
  function snapshot(round, eventType) {
    return {
      eventType,
      round,
      createdAt: `2026-09-16T1${round}:00:00.000Z`,
      triggerMessageId: `msg-${round}`,
      state: {
        version: round,
        currentStage: 'role2',
        currentSubStage: 'triage',
        currentFacility: { name: '二级救治机构' },
        classificationHistory: [{ severity: 'severe' }],
        transport: { priority: 'urgent' },
      },
    };
  }

  it('把 snapshots.jsonl 投影成时间线，最新在前', async () => {
    seedCase(TRAUMA_PROJECT, 'web_s1', {
      snapshots: [snapshot(1, 'round'), snapshot(2, 'stage_transition'), snapshot(3, 'round')],
    });

    const { status, body } = await request(
      `/cases/snapshots?projectId=${TRAUMA_PROJECT}&sessionId=web:s1`,
    );

    expect(status).toBe(200);
    expect(body.readOnly).toBe(true);
    expect(body.total).toBe(3);
    expect(body.snapshots.map((s) => s.round)).toEqual([3, 2, 1]);
    expect(body.snapshots[1]).toMatchObject({
      eventType: 'stage_transition',
      version: 2,
      triggerMessageId: 'msg-2',
      facilityName: '二级救治机构',
      severity: 'severe',
      transportPriority: 'urgent',
    });
    expect(body.snapshots[0].stage).toEqual({ main: 'role2', sub: 'triage' });
  });

  it('limit 截断，但 total 仍报全量', async () => {
    seedCase(TRAUMA_PROJECT, 'web_s1', {
      snapshots: [snapshot(1, 'round'), snapshot(2, 'round'), snapshot(3, 'round')],
    });

    const { body } = await request(
      `/cases/snapshots?projectId=${TRAUMA_PROJECT}&sessionId=web:s1&limit=2`,
    );

    expect(body.snapshots).toHaveLength(2);
    expect(body.total).toBe(3);
  });

  it('坏行被跳过而不是让整条时间线消失', async () => {
    seedCase(TRAUMA_PROJECT, 'web_s1', {
      snapshots: [snapshot(1, 'round'), '{not json', snapshot(2, 'round')],
    });

    const { body } = await request(
      `/cases/snapshots?projectId=${TRAUMA_PROJECT}&sessionId=web:s1`,
    );

    expect(body.total).toBe(2);
    expect(body.skipped).toBe(1);
  });

  it('没有 snapshots.jsonl 时返回空时间线', async () => {
    seedCase(TRAUMA_PROJECT, 'web_s1', { current: fullCaseState() });

    const { status, body } = await request(
      `/cases/snapshots?projectId=${TRAUMA_PROJECT}&sessionId=web:s1`,
    );

    expect(status).toBe(200);
    expect(body.snapshots).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('通用医学项目同样 404', async () => {
    const { status, body } = await request(
      `/cases/snapshots?projectId=${GENERAL_PROJECT}&sessionId=web:s1`,
    );

    expect(status).toBe(404);
    expect(body.code).toBe('CASE_STATE_UNSUPPORTED');
  });
});
