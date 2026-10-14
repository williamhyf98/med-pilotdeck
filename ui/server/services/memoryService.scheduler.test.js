// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * startMemoryScheduler has no request scope. In multi-user mode the UI-side
 * scheduler must stay off; in no-login mode it runs each cycle as the admin.
 */
async function loadService({ disableLocalAuth, admin }) {
  const scopesSeen = [];
  vi.doMock('../../../src/context/memory/edgeclaw-memory-core/lib/index.js', () => ({
    ALL_PROJECTS_MEMORY_EXPORT_FORMAT_VERSION: 1,
    EdgeClawMemoryService: class {},
    MemoryBundleValidationError: class extends Error {},
  }));
  vi.doMock('../projects.js', () => ({ extractProjectDirectory: vi.fn() }));
  vi.doMock('../constants/config.js', () => ({ DISABLE_LOCAL_AUTH: disableLocalAuth }));
  const getAdminUser = vi.fn(() => admin);
  vi.doMock('../database/db.js', () => ({ userDb: { getAdminUser } }));
  const { getUserScope } = await import('../middleware/userScope.js');
  vi.doMock('./pilotdeckConfig.js', () => ({
    buildMemoryDefaults: vi.fn(() => ({})),
    readPilotDeckConfigFile: vi.fn(() => {
      scopesSeen.push(getUserScope() ?? null);
      return { config: { memory: { enabled: true } } };
    }),
  }));
  const api = await import('./memoryService.js');
  return { api, scopesSeen, getAdminUser };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('startMemoryScheduler', () => {
  it('does nothing in multi-user mode', async () => {
    vi.useFakeTimers();
    const { api, scopesSeen, getAdminUser } = await loadService({ disableLocalAuth: false, admin: { id: 7 } });
    api.startMemoryScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(scopesSeen).toEqual([]); // no cycle ran (checked before getMemorySchedulerStatus reads config)
    expect(api.getMemorySchedulerStatus().running).toBe(false);
    expect(getAdminUser).not.toHaveBeenCalled();
  });

  it('does nothing in no-login mode when no admin exists', async () => {
    vi.useFakeTimers();
    const { api, scopesSeen } = await loadService({ disableLocalAuth: true, admin: undefined });
    api.startMemoryScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(scopesSeen).toEqual([]); // no cycle ran (checked before getMemorySchedulerStatus reads config)
    expect(api.getMemorySchedulerStatus().running).toBe(false);
  });

  it('runs every cycle inside the admin scope in no-login mode', async () => {
    vi.useFakeTimers();
    const { api, scopesSeen } = await loadService({ disableLocalAuth: true, admin: { id: 7 } });
    api.startMemoryScheduler();
    // startMemoryScheduler's own "is memory enabled" config check is unscoped by
    // design (system config); every later read comes from a scheduler cycle.
    // The immediate first cycle runs synchronously inside start, so skip just
    // that one unscoped read.
    await vi.advanceTimersByTimeAsync(60_000);
    api.stopMemoryScheduler();
    const cycleScopes = scopesSeen.slice(1);
    expect(cycleScopes.length).toBeGreaterThanOrEqual(2); // immediate run + one interval tick
    for (const scope of cycleScopes) expect(scope).toEqual({ userId: '7', role: 'admin' });
  });
});
