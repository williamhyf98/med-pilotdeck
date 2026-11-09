import {
  collectNetworkServices,
  NetworkAccessController,
  NetworkServiceRegistry,
} from '../../../src/network/serviceRegistry.js';
import { networkFetch } from '../../../src/network/fetch.js';
import {
  PolicyConflictError,
  createSecurityPolicyStore,
} from '../../../src/security/policy/PolicyStore.js';
import {
  parseCommandPolicy,
  REGISTERED_COMMANDS,
} from '../../../src/security/policy/parseCommandPolicy.js';
import { parseNetworkPolicy } from '../../../src/security/policy/parseNetworkPolicy.js';
import { readMcpConfigFile, writeMcpConfigFile } from './mcpConfig.js';
import {
  readPilotDeckConfigFile,
  writePilotDeckConfig,
} from './pilotdeckConfig.js';

const TEST_TIMEOUT_MS = 5_000;

export class SecurityPolicyServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SecurityPolicyServiceError';
    this.code = code;
    this.status = status;
  }
}

function requireRevision(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SecurityPolicyServiceError('REVISION_REQUIRED', `${field} is required.`);
  }
  return value.trim();
}

function mcpHttpServers(config) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.entries(servers).flatMap(([id, server]) => {
    const url = typeof server?.url === 'string'
      ? server.url
      : typeof server?.httpUrl === 'string'
        ? server.httpUrl
        : '';
    return url
      ? [{ id, transport: 'streamable_http', url }]
      : [];
  });
}

function urlForService(protocol, host, port) {
  const formattedHost = host.includes(':') && !host.startsWith('[')
    ? `[${host}]`
    : host;
  return `${protocol}://${formattedHost}:${port}`;
}

function ruleForService(policy, serviceId) {
  return policy.rules.find((rule) => rule.id === serviceId);
}

function effectiveService(baseService, rule) {
  if (!rule) return baseService;
  const protocol = rule.protocol === 'tcp' ? baseService.protocol : rule.protocol;
  const host = rule.host ?? baseService.host;
  return {
    ...baseService,
    protocol,
    host,
    port: rule.port,
    baseUrl: urlForService(protocol, host, rule.port),
    enabled: rule.enabled,
  };
}

function serviceStatus(service, lastTest) {
  if (!service.enabled) return 'disabled';
  return lastTest?.status ?? 'not_tested';
}

function publicService(service, policy, lastTest) {
  const rule = ruleForService(policy, service.id);
  const effective = effectiveService(service, rule);
  return {
    id: effective.id,
    name: effective.name,
    purpose: effective.purpose,
    protocol: effective.protocol,
    host: effective.host,
    port: effective.port,
    source: effective.source,
    enabled: effective.enabled,
    status: serviceStatus(effective, lastTest),
    ...(lastTest ? { lastTest } : {}),
  };
}

function publicCommands(policy) {
  return policy.commands.map((command) => {
    const ceiling = REGISTERED_COMMANDS[command.id];
    return {
      ...command,
      availableOptions: [...(ceiling?.options ?? [])],
      allowedInputRoots: [...(ceiling?.inputRoots ?? [])],
      allowedOutputRoots: [...(ceiling?.outputRoots ?? [])],
      maxTimeoutMs: ceiling?.maxTimeoutMs ?? command.timeoutMs,
    };
  });
}

function normalizeConfigRecord(record) {
  if (record?.parseError) {
    throw new SecurityPolicyServiceError(
      'CONFIG_INVALID',
      'The system configuration is invalid; security services cannot be listed.',
      500,
    );
  }
  return record?.config && typeof record.config === 'object'
    ? record.config
    : {};
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function configuredEnvironment(env, config) {
  const customEnv = isRecord(config?.customEnv) ? config.customEnv : {};
  return {
    ...env,
    ...Object.fromEntries(
      Object.entries(customEnv).filter(([, value]) => typeof value === 'string'),
    ),
  };
}

function replaceServiceUrl(raw, protocol, host, port) {
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new SecurityPolicyServiceError(
      'CONFIG_INVALID',
      `Registered service URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
  url.protocol = `${protocol}:`;
  url.hostname = host.replace(/^\[|\]$/gu, '');
  url.port = String(port);
  url.hash = '';
  return url.toString().replace(/\/+$/u, '');
}

function sourceDescriptor(service, context) {
  const source = service.source;
  if (source.startsWith('model.providers.') && source.endsWith('.url')) {
    const providerId = source.slice('model.providers.'.length, -'.url'.length);
    const provider = context.config?.model?.providers?.[providerId];
    if (!isRecord(provider) || typeof provider.url !== 'string') {
      throw new SecurityPolicyServiceError(
        'SERVICE_SOURCE_UNAVAILABLE',
        `Model service "${service.id}" no longer has an editable provider URL.`,
        409,
      );
    }
    return {
      kind: 'pilotdeck',
      rawUrl: provider.url,
      update: (nextUrl) => {
        const config = clone(context.config);
        config.model.providers[providerId].url = nextUrl;
        return { config };
      },
    };
  }

  if (source.startsWith('env.')) {
    const key = source.slice('env.'.length);
    const rawUrl = context.environment[key] ?? service.baseUrl;
    if (!key || typeof rawUrl !== 'string' || !rawUrl.trim()) {
      throw new SecurityPolicyServiceError(
        'SERVICE_SOURCE_UNAVAILABLE',
        `Environment service "${service.id}" has no editable URL source.`,
        409,
      );
    }
    return {
      kind: 'pilotdeck',
      rawUrl,
      update: (nextUrl) => {
        const config = clone(context.config);
        config.customEnv = isRecord(config.customEnv) ? config.customEnv : {};
        config.customEnv[key] = nextUrl;
        return { config };
      },
    };
  }

  if (source.startsWith('mcp.') && source.endsWith('.url')) {
    const serverId = source.slice('mcp.'.length, -'.url'.length);
    const servers = context.mcpRecord?.config?.mcpServers;
    const server = servers?.[serverId];
    if (!isRecord(server)) {
      throw new SecurityPolicyServiceError(
        'SERVICE_NOT_EDITABLE',
        `MCP service "${service.id}" is not registered in the global MCP configuration.`,
        409,
      );
    }
    const field = typeof server.url === 'string' ? 'url'
      : typeof server.httpUrl === 'string' ? 'httpUrl' : undefined;
    if (!field) {
      throw new SecurityPolicyServiceError(
        'SERVICE_NOT_EDITABLE',
        `MCP service "${service.id}" is not an editable HTTP service.`,
        409,
      );
    }
    return {
      kind: 'mcp',
      rawUrl: server[field],
      update: (nextUrl) => {
        const config = clone(context.mcpRecord.config);
        config.mcpServers[serverId][field] = nextUrl;
        return { mcpConfig: config };
      },
    };
  }

  throw new SecurityPolicyServiceError(
    'SERVICE_NOT_EDITABLE',
    `Service "${service.id}" does not have an editable registered source.`,
    409,
  );
}

export function createSecurityPolicyService(options = {}) {
  const env = options.env ?? process.env;
  const store = options.store ?? createSecurityPolicyStore({ env });
  const readConfig = options.readConfig ?? (() => readPilotDeckConfigFile());
  const readMcpConfig = options.readMcpConfig ?? (() => readMcpConfigFile('global'));
  const writeConfig = options.writeConfig ?? writePilotDeckConfig;
  const writeMcpConfig = options.writeMcpConfig ?? (
    (config) => writeMcpConfigFile('global', JSON.stringify(config))
  );
  const reloadConfig = options.reloadConfig ?? (async (config) => {
    const { reloadPilotDeckConfig } = await import('./pilotdeckConfigReloader.js');
    return reloadPilotDeckConfig(config);
  });
  const reloadGateway = options.reloadGateway ?? (async (kind, changedPath) => {
    try {
      const { getPilotDeckGateway } = await import('../pilotdeck-bridge.js');
      const gateway = await getPilotDeckGateway();
      if (kind === 'mcp' && gateway?.reloadExtensions) {
        return await gateway.reloadExtensions({ changedPaths: [changedPath] });
      }
      return gateway?.reloadConfig ? await gateway.reloadConfig() : { reloaded: false };
    } catch (error) {
      return {
        reloaded: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const lookup = options.lookup;
  const fetchImpl = options.fetchImpl;
  const testTimeoutMs = options.testTimeoutMs ?? TEST_TIMEOUT_MS;
  const lastTests = new Map();

  async function loadContext() {
    const snapshot = await store.reload();
    const config = normalizeConfigRecord(await readConfig());
    const mcpRecord = await readMcpConfig();
    const environment = configuredEnvironment(env, config);
    const registry = new NetworkServiceRegistry(
      collectNetworkServices({
        model: config.model,
        env: environment,
        mcpServers: mcpHttpServers(mcpRecord?.config),
      }),
    );
    return {
      snapshot,
      registry,
      baseServices: registry.list(),
      config,
      mcpRecord,
      environment,
    };
  }

  function serviceResponse(context, snapshot = context.snapshot) {
    return {
      services: context.baseServices.map((service) => publicService(
        service,
        snapshot.network,
        lastTests.get(service.id),
      )),
      networkRevision: snapshot.networkRevision,
      commandRevision: snapshot.commandRevision,
    };
  }

  function commandResponse(snapshot) {
    return {
      policy: snapshot.commands,
      commands: publicCommands(snapshot.commands),
      commandRevision: snapshot.commandRevision,
      networkRevision: snapshot.networkRevision,
    };
  }

  async function getServices() {
    return serviceResponse(await loadContext());
  }

  async function updateService(serviceId, input = {}) {
    const context = await loadContext();
    const service = context.baseServices.find((entry) => entry.id === serviceId);
    if (!service) {
      throw new SecurityPolicyServiceError(
        'SERVICE_NOT_REGISTERED',
        `Service "${serviceId}" is not registered by the system.`,
        404,
      );
    }
    const expectedRevision = requireRevision(input.expectedRevision, 'expectedRevision');
    const allowedKeys = new Set(['expectedRevision', 'host', 'port', 'protocol']);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
      throw new SecurityPolicyServiceError(
        'INVALID_SERVICE_UPDATE',
        'Only host, port, and protocol may be edited.',
      );
    }
    if (input.host !== undefined && (typeof input.host !== 'string' || !input.host.trim())) {
      throw new SecurityPolicyServiceError('INVALID_SERVICE_UPDATE', 'host must be a non-empty string.');
    }
    if (
      input.port !== undefined
      && (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535)
    ) {
      throw new SecurityPolicyServiceError('INVALID_SERVICE_UPDATE', 'port must be an integer from 1 to 65535.');
    }
    if (
      input.protocol !== undefined
      && !['http', 'https', 'ws', 'wss'].includes(input.protocol)
    ) {
      throw new SecurityPolicyServiceError('INVALID_SERVICE_UPDATE', 'protocol is not supported.');
    }

    const currentRule = ruleForService(context.snapshot.network, serviceId);
    const nextRule = {
      id: serviceId,
      enabled: currentRule?.enabled ?? true,
      host: input.host?.trim() ?? currentRule?.host ?? service.host,
      port: input.port ?? currentRule?.port ?? service.port,
      protocol: input.protocol ?? (
        currentRule?.protocol === 'tcp' ? service.protocol : currentRule?.protocol ?? service.protocol
      ),
      purpose: currentRule?.purpose ?? service.purpose,
    };
    const nextPolicy = {
      version: 1,
      mode: 'deny',
      rules: [
        ...context.snapshot.network.rules.filter((rule) => rule.id !== serviceId),
        nextRule,
      ],
    };
    const parsed = parseNetworkPolicy(nextPolicy);
    const source = sourceDescriptor(service, context);
    const nextUrl = replaceServiceUrl(
      source.rawUrl,
      nextRule.protocol,
      nextRule.host,
      nextRule.port,
    );
    const sourceUpdate = source.update(nextUrl);
    let saved;
    try {
      saved = await store.updateNetwork(parsed, expectedRevision);
    } catch (error) {
      if (error instanceof PolicyConflictError || error?.name === 'PolicyConflictError') {
        throw new SecurityPolicyServiceError(
          'POLICY_CONFLICT',
          'Security policy changed elsewhere. Reload before saving.',
          409,
        );
      }
      throw error;
    }

    try {
      if (sourceUpdate.config) {
        const written = await writeConfig(sourceUpdate.config);
        const localReload = await reloadConfig(written.config);
        const gatewayReload = await reloadGateway('pilotdeck', written.configPath);
        saved = {
          ...saved,
          sourceReload: {
            local: localReload,
            gateway: gatewayReload,
          },
        };
      } else if (sourceUpdate.mcpConfig) {
        const written = await writeMcpConfig(sourceUpdate.mcpConfig);
        const gatewayReload = await reloadGateway('mcp', written.path);
        saved = {
          ...saved,
          sourceReload: {
            gateway: gatewayReload,
          },
        };
      }
    } catch (error) {
      try {
        await store.updateNetwork(context.snapshot.network, saved.networkRevision);
      } catch (rollbackError) {
        throw new SecurityPolicyServiceError(
          'UPDATE_PARTIAL_FAILURE',
          `Service update failed and policy rollback also failed: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
          500,
        );
      }
      throw error;
    }

    lastTests.delete(serviceId);
    const refreshed = await loadContext();
    return {
      ...serviceResponse(refreshed, refreshed.snapshot),
      sourceReload: saved.sourceReload,
    };
  }

  async function testService(serviceId) {
    const context = await loadContext();
    const service = context.baseServices.find((entry) => entry.id === serviceId);
    if (!service) {
      throw new SecurityPolicyServiceError(
        'SERVICE_NOT_REGISTERED',
        `Service "${serviceId}" is not registered by the system.`,
        404,
      );
    }
    const effective = effectiveService(service, ruleForService(context.snapshot.network, serviceId));
    const startedAt = Date.now();
    let result;
    if (!effective.enabled) {
      result = {
        ok: false,
        status: 'disabled',
        latencyMs: 0,
        testedAt: new Date().toISOString(),
        error: 'Service is disabled by the security policy.',
      };
    } else {
      try {
        const networkAccess = new NetworkAccessController({
          registry: context.registry,
          getPolicy: () => context.snapshot.network,
          ...(lookup ? { lookup } : {}),
        });
        const response = await networkFetch(
          effective.baseUrl,
          { method: 'HEAD' },
          {
            timeoutMs: testTimeoutMs,
            networkAccess,
            ...(fetchImpl ? { fetchImpl } : {}),
          },
        );
        await response.body?.cancel().catch(() => undefined);
        result = {
          ok: true,
          status: 'reachable',
          httpStatus: response.status,
          latencyMs: Date.now() - startedAt,
          testedAt: new Date().toISOString(),
        };
      } catch (error) {
        result = {
          ok: false,
          status: 'unreachable',
          latencyMs: Date.now() - startedAt,
          testedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    lastTests.set(serviceId, result);
    return {
      service: publicService(service, context.snapshot.network, result),
      test: result,
      networkRevision: context.snapshot.networkRevision,
    };
  }

  async function getCommands() {
    return commandResponse((await loadContext()).snapshot);
  }

  async function updateCommands(input = {}) {
    const expectedRevision = requireRevision(input.expectedRevision, 'expectedRevision');
    const policy = input.policy ?? input;
    const parsed = parseCommandPolicy(policy);
    let saved;
    try {
      saved = await store.updateCommands(parsed, expectedRevision);
    } catch (error) {
      if (error instanceof PolicyConflictError || error?.name === 'PolicyConflictError') {
        throw new SecurityPolicyServiceError(
          'POLICY_CONFLICT',
          'Security policy changed elsewhere. Reload before saving.',
          409,
        );
      }
      throw error;
    }
    return commandResponse(saved);
  }

  async function reload() {
    const context = await loadContext();
    return {
      ...serviceResponse(context),
      ...commandResponse(context.snapshot),
      reloadedAt: new Date().toISOString(),
    };
  }

  return {
    getServices,
    updateService,
    testService,
    getCommands,
    updateCommands,
    reload,
  };
}

export default createSecurityPolicyService();
