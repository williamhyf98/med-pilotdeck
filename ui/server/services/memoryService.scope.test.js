// @vitest-environment node
/**
 * Task 8 —— 请求作用域的解析规则。
 *
 * 必须跑在 node 环境：memoryService.js 顶层 import `node:sqlite`，
 * 在默认的 jsdom（client）环境里 Vite 会拒绝打包内建模块。
 *
 * 这是「在项目 A 的面板里改不到项目 B」的真正实现处；routes/memory.test.js 只
 * 证明路由会把这里抛出的冲突翻成 409。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let PILOT_HOME = '';

/**
 * A system project's workspace path only resolves back to its projectId through
 * the `.cwd` marker under `projects/`. Lay down a real one so the "path agrees
 * with id" case is actually exercised rather than accidentally passing.
 */
function seedProject(projectId, typeKey) {
  const workspaceDir = path.join(PILOT_HOME, 'workspaces', typeKey, projectId);
  const markerDir = path.join(PILOT_HOME, 'projects', typeKey, projectId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, '.cwd'), workspaceDir, 'utf8');
  return workspaceDir;
}

async function loadService() {
  // 记忆内核不是这里要测的，桩掉它以免把整个存储层拖进来。
  vi.doMock('../../../src/context/memory/edgeclaw-memory-core/lib/index.js', () => ({
    ALL_PROJECTS_MEMORY_EXPORT_FORMAT_VERSION: 1,
    EdgeClawMemoryService: class {},
    MemoryBundleValidationError: class extends Error {},
  }));
  vi.doMock('../projects.js', () => ({
    extractProjectDirectory: vi.fn(async (name) => path.join(PILOT_HOME, 'workspaces', name)),
  }));
  return import('./memoryService.js');
}

function request({ query = {}, body = {}, params = {} } = {}) {
  return { query, body, params };
}

describe('resolveProjectPathFromRequest', () => {
  beforeEach(() => {
    PILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-scope-'));
    process.env.PILOT_HOME = PILOT_HOME;
  });

  afterEach(() => {
    fs.rmSync(PILOT_HOME, { recursive: true, force: true });
    delete process.env.PILOT_HOME;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('prefers the stable projectId over the display projectPath', async () => {
    const { resolveProjectPathFromRequest } = await loadService();

    const resolved = await resolveProjectPathFromRequest(
      request({ query: { projectId: 'trauma_med-abc123' } }),
    );

    expect(resolved).toBe('trauma_med-abc123');
  });

  it('reads projectId from the body for write requests', async () => {
    const { resolveProjectPathFromRequest } = await loadService();

    const resolved = await resolveProjectPathFromRequest(
      request({ body: { projectId: 'general_med-xyz' } }),
    );

    expect(resolved).toBe('general_med-xyz');
  });

  it('rejects a projectPath that resolves to a different project', async () => {
    const { resolveProjectPathFromRequest, MemoryScopeMismatchError } = await loadService();
    seedProject('trauma_med-abc123', 'trauma_med');
    const otherWorkspace = seedProject('trauma_med-zzz999', 'trauma_med');

    await expect(resolveProjectPathFromRequest(request({
      query: { projectId: 'trauma_med-abc123', projectPath: otherWorkspace },
    }))).rejects.toThrow(MemoryScopeMismatchError);
  });

  it('accepts a projectPath that resolves to the same project', async () => {
    const { resolveProjectPathFromRequest } = await loadService();
    const projectId = 'trauma_med-abc123';
    const workspaceDir = seedProject(projectId, 'trauma_med');

    const resolved = await resolveProjectPathFromRequest(
      request({ query: { projectId, projectPath: workspaceDir } }),
    );

    expect(resolved).toBe(projectId);
  });

  it('still accepts a bare projectPath from legacy clients', async () => {
    const { resolveProjectPathFromRequest } = await loadService();

    const resolved = await resolveProjectPathFromRequest(
      request({ query: { projectPath: '/tmp/linked-repo' } }),
    );

    expect(resolved).toBe('/tmp/linked-repo');
  });

  it('names projectId first when nothing addressable was supplied', async () => {
    const { resolveProjectPathFromRequest } = await loadService();

    await expect(resolveProjectPathFromRequest(request())).rejects.toThrow(
      /projectId, projectPath or projectName is required/u,
    );
  });
});
