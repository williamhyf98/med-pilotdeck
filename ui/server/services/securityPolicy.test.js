import { describe, expect, it, vi } from 'vitest';

const baseConfig = {
  model: {
    providers: {
      local: {
        protocol: 'openai',
        url: 'http://127.0.0.1:19000/v1',
      },
    },
  },
};

const mcpConfig = {
  config: {
    mcpServers: {
      imaging: {
        url: 'http://10.20.30.40:18080/mcp',
      },
    },
  },
};

function fakeResponse(status = 200) {
  return new Response('', {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('security policy service', () => {
  it('lists only registered services without exposing credentials', async () => {
    const { createSecurityPolicyService } = await import('./securityPolicy.js');
    const store = {
      reload: vi.fn(async () => ({
        commands: { version: 1, mode: 'registered_only', commands: [] },
        network: { version: 1, mode: 'deny', rules: [] },
        commandRevision: 'commands-1',
        networkRevision: 'network-1',
      })),
      getSnapshot: vi.fn(),
    };
    const service = createSecurityPolicyService({
      store,
      env: {
        MED_RADAR_API_BASE: 'https://10.20.30.41:18120',
      },
      readConfig: () => ({
        config: {
          ...baseConfig,
          model: {
            providers: {
              local: {
                ...baseConfig.model.providers.local,
                apiKey: 'sk-secret',
              },
            },
          },
        },
      }),
      readMcpConfig: async () => mcpConfig,
    });

    const result = await service.getServices();
    expect(result.networkRevision).toBe('network-1');
    expect(result.services.map(({ id }) => id)).toEqual([
      'mcp.imaging',
      'model.local',
      'service.radar',
      'service.rag',
    ]);
    expect(result.services.find(({ id }) => id === 'model.local')).not.toHaveProperty('apiKey');
    expect(result.services.find(({ id }) => id === 'model.local')).toMatchObject({
      host: '127.0.0.1',
      port: 19000,
      protocol: 'http',
      status: 'not_tested',
    });
  });

  it('updates only the selected registered service and rejects unknown service ids', async () => {
    const { createSecurityPolicyService } = await import('./securityPolicy.js');
    const snapshot = {
      commands: { version: 1, mode: 'registered_only', commands: [] },
      network: { version: 1, mode: 'deny', rules: [] },
      commandRevision: 'commands-1',
      networkRevision: 'network-1',
    };
    let writtenConfig;
    let currentSnapshot = snapshot;
    const store = {
      reload: vi.fn(async () => currentSnapshot),
      updateNetwork: vi.fn(async (policy, revision) => {
        expect(revision).toBe('network-1');
        expect(policy.rules).toEqual([{
          id: 'model.local',
          enabled: true,
          host: '127.0.0.2',
          port: 19001,
          protocol: 'http',
          purpose: '系统模型请求',
        }]);
        currentSnapshot = {
          ...snapshot,
          network: policy,
          networkRevision: 'network-2',
        };
        return currentSnapshot;
      }),
    };
    const service = createSecurityPolicyService({
      store,
      readConfig: () => ({ config: writtenConfig ?? baseConfig }),
      readMcpConfig: async () => mcpConfig,
      writeConfig: vi.fn(async (config) => {
        writtenConfig = config;
        return { configPath: '/tmp/pilotdeck.yaml', config };
      }),
      reloadConfig: vi.fn(async () => ({ processEnv: { reloaded: true } })),
      reloadGateway: vi.fn(async () => ({ reloaded: true })),
    });

    const updated = await service.updateService('model.local', {
      expectedRevision: 'network-1',
      host: '127.0.0.2',
      port: 19001,
      protocol: 'http',
    });
    expect(updated.networkRevision).toBe('network-2');
    expect(writtenConfig.model.providers.local.url).toBe('http://127.0.0.2:19001/v1');
    await expect(service.updateService('service.unknown', {
      expectedRevision: 'network-2',
      host: '127.0.0.3',
      port: 19002,
      protocol: 'http',
    })).rejects.toMatchObject({ code: 'SERVICE_NOT_REGISTERED' });
  });

  it('tests the registered service address and never accepts a caller-provided URL', async () => {
    const { createSecurityPolicyService } = await import('./securityPolicy.js');
    const service = createSecurityPolicyService({
      store: {
        reload: vi.fn(async () => ({
          commands: { version: 1, mode: 'registered_only', commands: [] },
          network: { version: 1, mode: 'deny', rules: [{
            id: 'model.local',
            enabled: true,
            host: '127.0.0.1',
            port: 19000,
            protocol: 'http',
            purpose: '系统模型请求',
          }] },
          commandRevision: 'commands-1',
          networkRevision: 'network-1',
        })),
      },
      readConfig: () => ({ config: baseConfig }),
      readMcpConfig: async () => ({ config: { mcpServers: {} } }),
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      fetchImpl: vi.fn(async (input) => {
        expect(String(input)).toBe('http://127.0.0.1:19000');
        return fakeResponse(503);
      }),
    });

    const result = await service.testService('model.local');
    expect(result.test.ok).toBe(true);
    expect(result.test.httpStatus).toBe(503);
    expect(result.test.status).toBe('reachable');
    await expect(service.testService('model.unknown')).rejects.toMatchObject({
      code: 'SERVICE_NOT_REGISTERED',
    });
  });

  it('rejects a command policy update that tries to add an unregistered command', async () => {
    const { createSecurityPolicyService } = await import('./securityPolicy.js');
    const store = {
      reload: vi.fn(async () => ({
        commands: { version: 1, mode: 'registered_only', commands: [] },
        network: { version: 1, mode: 'deny', rules: [] },
        commandRevision: 'commands-1',
        networkRevision: 'network-1',
      })),
      updateCommands: vi.fn(),
    };
    const service = createSecurityPolicyService({ store });

    await expect(service.updateCommands({
      expectedRevision: 'commands-1',
      policy: {
        version: 1,
        mode: 'registered_only',
        commands: [{
          id: 'python.run',
          enabled: true,
          allowedOptions: [],
          inputRoots: [],
          outputRoots: [],
          writable: false,
          networkRuleIds: [],
          timeoutMs: 1000,
        }],
      },
    })).rejects.toThrow(/registered|unknown|Invalid/i);
    expect(store.updateCommands).not.toHaveBeenCalled();
  });

  it('writes environment-backed service addresses into customEnv and reloads them', async () => {
    const { createSecurityPolicyService } = await import('./securityPolicy.js');
    const snapshot = {
      commands: { version: 1, mode: 'registered_only', commands: [] },
      network: { version: 1, mode: 'deny', rules: [] },
      commandRevision: 'commands-1',
      networkRevision: 'network-1',
    };
    let writtenConfig;
    const store = {
      reload: vi.fn(async () => snapshot),
      updateNetwork: vi.fn(async (policy) => ({
        ...snapshot,
        network: policy,
        networkRevision: 'network-2',
      })),
    };
    const service = createSecurityPolicyService({
      store,
      env: { MED_RADAR_API_BASE: 'https://10.20.30.41:18120/v1' },
      readConfig: () => ({
        config: {
          customEnv: { MED_RADAR_API_BASE: 'https://10.20.30.41:18120/v1' },
        },
      }),
      readMcpConfig: async () => ({ config: { mcpServers: {} } }),
      writeConfig: vi.fn(async (config) => {
        writtenConfig = config;
        return { configPath: '/tmp/pilotdeck.yaml', config };
      }),
      reloadConfig: vi.fn(async () => ({ processEnv: { reloaded: true } })),
      reloadGateway: vi.fn(async () => ({ reloaded: true })),
    });

    await service.updateService('service.radar', {
      expectedRevision: 'network-1',
      host: '10.20.30.42',
      port: 18121,
      protocol: 'https',
    });

    expect(writtenConfig.customEnv.MED_RADAR_API_BASE).toBe('https://10.20.30.42:18121/v1');
  });

  it('writes global HTTP MCP service addresses without editing project or plugin config', async () => {
    const { createSecurityPolicyService } = await import('./securityPolicy.js');
    const snapshot = {
      commands: { version: 1, mode: 'registered_only', commands: [] },
      network: { version: 1, mode: 'deny', rules: [] },
      commandRevision: 'commands-1',
      networkRevision: 'network-1',
    };
    let writtenMcp;
    const mcpRecord = {
      config: {
        mcpServers: {
          imaging: { url: 'http://10.20.30.40:18080/mcp' },
        },
      },
    };
    const store = {
      reload: vi.fn(async () => snapshot),
      updateNetwork: vi.fn(async (policy) => ({
        ...snapshot,
        network: policy,
        networkRevision: 'network-2',
      })),
    };
    const service = createSecurityPolicyService({
      store,
      readConfig: () => ({ config: {} }),
      readMcpConfig: async () => mcpRecord,
      writeMcpConfig: vi.fn(async (config) => {
        writtenMcp = config;
        return { path: '/tmp/mcp.json', config };
      }),
      reloadGateway: vi.fn(async () => ({ reloaded: true })),
    });

    await service.updateService('mcp.imaging', {
      expectedRevision: 'network-1',
      host: '10.20.30.41',
      port: 18081,
      protocol: 'http',
    });

    expect(writtenMcp.mcpServers.imaging.url).toBe('http://10.20.30.41:18081/mcp');
  });
});
