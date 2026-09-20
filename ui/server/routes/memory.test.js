import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

/**
 * `routes/memory.js` imports the memory core for `MemoryBundleValidationError`
 * alone, and that module graph reaches `node:sqlite`, which Vite refuses to
 * bundle. The route only ever uses the error class, so stub the module rather
 * than dragging the storage layer into a route test.
 */
function mockMemoryCoreLib() {
  vi.doMock('../../../src/context/memory/edgeclaw-memory-core/lib/index.js', () => ({
    MemoryBundleValidationError: class MemoryBundleValidationError extends Error {
      constructor(message) {
        super(message);
        this.name = 'MemoryBundleValidationError';
      }
    },
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('memory clear route', () => {
  it('returns a dashboard snapshot after clearing all memory with project context', async () => {
    const { request, clearAllMemoryData, getMemoryServiceForRequest } = await createMemoryApp();

    const result = await request('/api/memory/clear?projectPath=/tmp/pilotdeck-project', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'all_memory',
        projectPath: '/tmp/pilotdeck-project',
      }),
    });

    expect(clearAllMemoryData).toHaveBeenCalledOnce();
    expect(getMemoryServiceForRequest).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      scope: 'all_memory',
      cleared: {
        l0Sessions: 1,
        pipelineState: 2,
        memoryFiles: 3,
        projectMetas: 4,
      },
      dashboard: {
        overview: {
          totalMemories: 0,
          scheduler: {
            enabled: true,
            running: false,
            intervalMs: 60000,
          },
        },
        settings: {
          reasoningMode: 'answer_first',
          autoIndexIntervalMinutes: 30,
          autoDreamIntervalMinutes: 60,
        },
        workspace: {
          workspaceMode: 'project',
          totalFiles: 0,
          totalProjects: 0,
          totalFeedback: 0,
          projectEntries: [],
          feedbackEntries: [],
          deprecatedProjectEntries: [],
          deprecatedFeedbackEntries: [],
        },
        userSummary: {
          summary: 'empty',
        },
        caseTraces: [],
        indexTraces: [],
        dreamTraces: [],
      },
    });
  });
});

describe('memory scope identity (Task 8)', () => {
  it('addresses the service by stable projectId', async () => {
    const { request, getMemoryServiceForRequest } = await createMemoryApp();

    const result = await request('/api/memory/identity?projectId=trauma_med-abc123');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      projectId: 'trauma_med-abc123',
      projectType: 'war_trauma',
      dataDir: '/tmp/pilotdeck-data',
      readOnly: false,
    });
    expect(getMemoryServiceForRequest).toHaveBeenCalledOnce();
  });

  it('refuses a request whose projectId and projectPath disagree', async () => {
    const { request } = await createMemoryApp();

    const result = await request(
      '/api/memory/project-meta?projectId=trauma_med-abc123&projectPath=/tmp/other-project',
      {
        method: 'POST',
        body: JSON.stringify({ description: 'edited from the wrong panel' }),
      },
    );

    // 409, not 400: the request is well-formed but ambiguous about which
    // project it means, and guessing is the exact bug Task 8 removes.
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      code: 'MEMORY_SCOPE_MISMATCH',
      projectId: 'trauma_med-abc123',
      projectPath: '/tmp/other-project',
    });
  });

  it('accepts a projectPath that agrees with the projectId', async () => {
    const { request } = await createMemoryApp();

    const result = await request('/api/memory/identity?projectId=abc&projectPath=/tmp/abc');

    expect(result.status).toBe(200);
    expect(result.body.projectId).toBe('abc');
  });
});

describe('index case trace routes (Task 8 rename)', () => {
  it('serves recall traces at /index-case-traces without a deprecation header', async () => {
    const { request, service } = await createMemoryApp();

    const result = await request('/api/memory/index-case-traces?projectId=abc&limit=5');

    expect(result.status).toBe(200);
    expect(service.listCaseTraces).toHaveBeenCalledWith(5);
    expect(result.headers.get('deprecation')).toBeNull();
  });

  it('keeps /cases working but marks it deprecated', async () => {
    const { request, service } = await createMemoryApp();

    const result = await request('/api/memory/cases?projectId=abc&limit=5');

    expect(result.status).toBe(200);
    expect(service.listCaseTraces).toHaveBeenCalledWith(5);
    expect(result.headers.get('deprecation')).toBe('true');
    expect(result.headers.get('link')).toContain('/api/memory/index-case-traces');
  });

  it('keeps /cases/:caseId working but marks it deprecated', async () => {
    const { request, service } = await createMemoryApp();
    service.getCaseTrace = vi.fn(() => ({ caseId: 'c1' }));

    const result = await request('/api/memory/cases/c1?projectId=abc');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ caseId: 'c1' });
    expect(result.headers.get('deprecation')).toBe('true');
  });

  it('serves a single trace at /index-case-traces/:caseId', async () => {
    const { request, service } = await createMemoryApp();
    service.getCaseTrace = vi.fn(() => ({ caseId: 'c1' }));

    const result = await request('/api/memory/index-case-traces/c1?projectId=abc');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ caseId: 'c1' });
    expect(result.headers.get('deprecation')).toBeNull();
  });
});

describe('memory settings route', () => {
  it('saves answer_first reasoning mode', async () => {
    const { request, writePilotDeckConfig } = await createMemorySettingsApp({
      memory: {
        reasoningMode: 'accuracy_first',
        autoIndexIntervalMinutes: 30,
        autoDreamIntervalMinutes: 60,
      },
    });

    const result = await request('/api/memory/settings?projectPath=/tmp/pilotdeck-project', {
      method: 'POST',
      body: JSON.stringify({ reasoningMode: 'answer_first' }),
    });

    expect(result.status).toBe(200);
    expect(result.body.reasoningMode).toBe('answer_first');
    expect(writePilotDeckConfig).toHaveBeenCalledWith(expect.objectContaining({
      memory: expect.objectContaining({ reasoningMode: 'answer_first' }),
    }));
  });

  it('saves accuracy_first reasoning mode', async () => {
    const { request, writePilotDeckConfig } = await createMemorySettingsApp({
      memory: {
        reasoningMode: 'answer_first',
        autoIndexIntervalMinutes: 30,
        autoDreamIntervalMinutes: 60,
      },
    });

    const result = await request('/api/memory/settings?projectPath=/tmp/pilotdeck-project', {
      method: 'POST',
      body: JSON.stringify({ reasoningMode: 'accuracy_first' }),
    });

    expect(result.status).toBe(200);
    expect(result.body.reasoningMode).toBe('accuracy_first');
    expect(writePilotDeckConfig).toHaveBeenCalledWith(expect.objectContaining({
      memory: expect.objectContaining({ reasoningMode: 'accuracy_first' }),
    }));
  });

  it('rejects invalid reasoning mode without saving config', async () => {
    const { request, writePilotDeckConfig } = await createMemorySettingsApp({
      memory: {
        reasoningMode: 'answer_first',
        autoIndexIntervalMinutes: 30,
        autoDreamIntervalMinutes: 60,
      },
    });

    const result = await request('/api/memory/settings?projectPath=/tmp/pilotdeck-project', {
      method: 'POST',
      body: JSON.stringify({ reasoningMode: 'fast_mode' }),
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('memory.reasoningMode must be answer_first or accuracy_first');
    expect(writePilotDeckConfig).not.toHaveBeenCalled();
  });
});

async function createMemoryApp() {
  const clearAllMemoryData = vi.fn(async () => ({
    scope: 'all_memory',
    clearedAt: '2026-07-09T00:00:00.000Z',
    cleared: {
      l0Sessions: 1,
      pipelineState: 2,
      memoryFiles: 3,
      projectMetas: 4,
    },
  }));

  const store = {
    getWorkspaceMode: vi.fn(() => 'project'),
    getRootDir: vi.fn(() => '/tmp/pilotdeck-memory-store'),
    getProjectMeta: vi.fn(() => null),
  };
  const repository = {
    getFileMemoryStore: vi.fn(() => store),
    getWorkspaceMode: vi.fn(() => 'project'),
    listMemoryEntries: vi.fn(() => []),
    getMemoryRecordsByIds: vi.fn(() => []),
  };
  const service = {
    repository,
    overview: vi.fn(() => ({ totalMemories: 0 })),
    getUserSummary: vi.fn(() => ({ summary: 'empty' })),
    listCaseTraces: vi.fn(() => []),
    listIndexTraces: vi.fn(() => []),
    listDreamTraces: vi.fn(() => []),
  };
  const getMemoryServiceForRequest = vi.fn(async (req) => {
    const projectId = req.query?.projectId || req.body?.projectId || '';
    const projectPath = req.query?.projectPath || req.body?.projectPath || '';
    if (projectId && projectPath && projectPath !== `/tmp/${projectId}`) {
      const error = new Error(`projectId "${projectId}" does not match projectPath "${projectPath}"`);
      error.code = 'MEMORY_SCOPE_MISMATCH';
      error.projectId = projectId;
      error.projectPath = projectPath;
      throw error;
    }
    return {
      projectPath: '/tmp/pilotdeck-project',
      dataDir: '/tmp/pilotdeck-data',
      service,
      identity: {
        projectId: projectId || 'trauma_med-abc123',
        projectType: 'war_trauma',
        projectTypeKey: 'trauma_med',
        dataDir: '/tmp/pilotdeck-data',
        readOnly: false,
      },
    };
  });

  vi.doMock('../services/memoryService.js', () => ({
    clearAllMemoryData,
    exportAllProjectsMemoryBundle: vi.fn(),
    getMemoryServiceForRequest,
    getMemorySchedulerStatus: vi.fn(() => ({
      enabled: true,
      running: false,
      intervalMs: 60000,
    })),
    importAllProjectsMemoryBundle: vi.fn(),
    rollbackLastMemoryDream: vi.fn(),
    runManualMemoryDream: vi.fn(),
    runManualMemoryFlush: vi.fn(),
  }));
  vi.doMock('../services/pilotdeckConfig.js', () => ({
    readPilotDeckConfigFile: vi.fn(() => ({ config: {} })),
    writePilotDeckConfig: vi.fn(async (config) => ({ config })),
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({
    reloadPilotDeckConfig: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  mockMemoryCoreLib();

  const { default: memoryRoutes } = await import('./memory.js');
  const app = express();
  app.use(express.json());
  app.use('/api/memory', memoryRoutes);

  return {
    clearAllMemoryData,
    getMemoryServiceForRequest,
    service,
    request: (path, init) => requestJson(app, path, init),
  };
}

async function createMemorySettingsApp(initialConfig) {
  let config = structuredClone(initialConfig);
  const writePilotDeckConfig = vi.fn(async (nextConfig) => {
    config = structuredClone(nextConfig);
    return { config };
  });

  vi.doMock('../services/memoryService.js', () => ({
    clearAllMemoryData: vi.fn(),
    exportAllProjectsMemoryBundle: vi.fn(),
    getMemoryServiceForRequest: vi.fn(async () => ({
      projectPath: '/tmp/pilotdeck-project',
      dataDir: '/tmp/pilotdeck-data',
      service: { repository: {} },
    })),
    getMemorySchedulerStatus: vi.fn(() => ({
      enabled: true,
      running: false,
      intervalMs: 60000,
    })),
    importAllProjectsMemoryBundle: vi.fn(),
    rollbackLastMemoryDream: vi.fn(),
    runManualMemoryDream: vi.fn(),
    runManualMemoryFlush: vi.fn(),
  }));
  vi.doMock('../services/pilotdeckConfig.js', () => ({
    readPilotDeckConfigFile: vi.fn(() => ({ config })),
    writePilotDeckConfig,
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({
    reloadPilotDeckConfig: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  mockMemoryCoreLib();

  const { default: memoryRoutes } = await import('./memory.js');
  const app = express();
  app.use(express.json());
  app.use('/api/memory', memoryRoutes);

  return {
    writePilotDeckConfig,
    request: (path, init) => requestJson(app, path, init),
  };
}

async function requestJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      ...init,
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
