// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let home;
let api;
afterEach(() => {
  api?.closeMemoryServices();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

it('existing and new projects follow global settings; trauma service rejects project notes before model calls', async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-global-'));
  vi.stubEnv('PILOT_HOME', home);
  vi.stubEnv('PILOTDECK_CONFIG_PATH', path.join(home, 'pilotdeck.yaml'));
  const writeConfig = (mode) => fs.writeFileSync(path.join(home, 'pilotdeck.yaml'),
    `memory:\n  enabled: true\n  maintenanceMode: ${mode}\n  autoIndexIntervalMinutes: 90\n  autoDreamIntervalMinutes: 120\n`);
  writeConfig('manual');
  api = await import('./memoryService.js');
  const get = (id) => api.getMemoryServiceForRequest({ query: { projectId: id } });
  for (const id of ['general_med-old', 'trauma_med-old']) {
    const { service } = await get(id);
    service.repository.setPipelineState('indexingSettings', { maintenanceMode: 'immediate', autoIndexIntervalMinutes: 1 });
    expect(service.getSettings()).toMatchObject({ maintenanceMode: 'manual', autoIndexIntervalMinutes: 90 });
  }
  api.closeMemoryServices();
  // The cold scheduler discovers both stored project types, without a dashboard request.
  await api.runMemorySchedulerCycle();
  const coldTrauma = await get('trauma_med-old');
  const traces = [];
  coldTrauma.service.extractor.callStructuredJson = async () => { throw new Error('Wrong prompt profile'); };
  expect(await coldTrauma.service.extractor.createUserMemoryNote({
    timestamp: new Date().toISOString(), focusUserTurn: { role: 'user', content: '我是医生' },
    batchContextMessages: [], classification: { type: 'user', reason: 'test', evidence: 'test' },
    debugTrace: trace => traces.push(trace),
  })).toBeNull();
  expect(traces).toEqual([]);
  api.closeMemoryServices();
  writeConfig('immediate');
  for (const id of ['general_med-old', 'trauma_med-old', 'general_med-new', 'trauma_med-new']) {
    const { service } = await get(id);
    expect(service.getSettings()).toMatchObject({ maintenanceMode: 'immediate', autoIndexIntervalMinutes: 90, autoDreamIntervalMinutes: 120 });
    if (id.startsWith('trauma_med-')) {
      // If the trauma hard gate is missing, this boundary is reached and the test fails.
      service.extractor.callStructuredJson = async () => { throw new Error('Unexpected model invocation'); };
      const errors = [];
      const note = await service.extractor.createProjectMemoryNote({
        timestamp: new Date().toISOString(), focusUserTurn: { role: 'user', content: '患者血压80' },
        batchContextMessages: [], classification: { type: 'project', reason: 'test', evidence: 'test' },
        debugTrace: (trace) => errors.push(trace),
      });
      expect(note).toBeNull();
      expect(errors).toEqual([]);
    }
  }
});
