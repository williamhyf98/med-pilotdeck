#!/usr/bin/env node
// Run the authenticated UI -> Gateway -> trauma runner path against an isolated test server.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { runTurn } from './run-skill-e2e-multiuser.ts';

const server = process.env.PILOTDECK_E2E_SERVER ?? 'http://127.0.0.1:3151';
const adminPassword = process.env.PILOTDECK_E2E_ADMIN_PASS;
const userName = process.env.PILOTDECK_E2E_USER ?? 'task9-trauma-e2e';
const userPassword = process.env.PILOTDECK_E2E_USER_PASS ?? 'task9-trauma-only-pass';
if (!adminPassword) throw new Error('PILOTDECK_E2E_ADMIN_PASS is required');

async function request(path, method, body, token) {
  const response = await fetch(`${server}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}

const admin = await request('/api/auth/login', 'POST', { username: 'admin', password: adminPassword });
assert.equal(admin.status, 200, 'admin login');
const created = await request('/api/admin/users', 'POST', {
  username: userName, password: userPassword, role: 'user',
}, admin.data.token);
assert.ok([201, 409].includes(created.status), `test user setup: ${created.status}`);
const user = await request('/api/auth/login', 'POST', { username: userName, password: userPassword });
assert.equal(user.status, 200, 'test user login');
const token = user.data.token;
const projectResponse = await request('/api/projects/create-system', 'POST', {
  type: 'war_trauma', displayName: 'task9-trauma-runner',
}, token);
assert.equal(projectResponse.status, 200, JSON.stringify(projectResponse.data));
const project = projectResponse.data.project;

const turn = await runTurn(token, {
  command: '战创伤推演：右小腿开放性损伤，伤后出血，已做压迫止血，心率 118 次/分。',
  options: {
    projectPath: project.fullPath,
    cwd: project.fullPath,
    runMode: 'agent',
    permissionMode: 'bypassPermissions',
    sessionSummary: '右小腿开放伤，心率 118',
    traumaForm: {
      statedSubStage: 'primary_first_aid',
      injuryNarrative: '右小腿开放性损伤，伤后出血。',
      treatmentNarrative: '现场已使用敷料压迫止血。',
      evacuationNarrative: '',
      note: '',
      vitals: { heartRate: 118, systolicBloodPressure: 100 },
    },
  },
}, { timeoutMs: 300_000 });

const visible = turn.frames.filter((frame) => [
  'stream_delta', 'thinking', 'tool_use', 'tool_result', 'error', 'file_artifacts', 'agent_activity', 'status',
].includes(frame.kind));
const home = project.fullPath.split('/workspaces/')[0];
const outputLeak = visible.some((frame) => JSON.stringify(frame).includes(home));
const stepCount = turn.frames.filter((frame) =>
  frame.kind === 'tool_use' && frame.toolInput?.traumaRunnerStep === true).length;
let caseState = null;
if (turn.sessionId) {
  const state = await request(
    `/api/trauma/cases/${encodeURIComponent(turn.sessionId)}?projectKey=${encodeURIComponent(project.name)}`,
    'GET', null, token,
  );
  assert.equal(state.status, 200, JSON.stringify(state.data));
  caseState = state.data;
}
const result = {
  project: project.name,
  sessionId: turn.sessionId ?? null,
  stopReason: turn.stopReason,
  stepCount,
  outputLeak,
  caseRound: caseState?.current?.round ?? null,
  caseStage: caseState?.current?.currentStage ?? null,
  caseSnapshots: caseState?.snapshots?.length ?? 0,
  frameKinds: [...new Set(turn.frames.map((frame) => frame.kind))],
};
if (process.env.PILOTDECK_E2E_REPORT) {
  await writeFile(process.env.PILOTDECK_E2E_REPORT, JSON.stringify({ result, frames: turn.frames, caseState }, null, 2));
}
console.log(JSON.stringify(result, null, 2));
assert.equal(turn.stopReason, 'complete');
assert.ok(stepCount > 0, 'trauma runner must emit progress steps');
assert.ok((caseState?.current?.round ?? 0) >= 1, 'case must persist after runner turn');
assert.equal(outputLeak, false, 'user-visible frames must not expose absolute home paths');
