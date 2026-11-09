import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ModelConfig } from "../model/protocol/canonical.js";
import type { PilotDeckMcpServerSpec } from "../mcp/protocol/types.js";
import type { NetworkPolicy, NetworkRule } from "../security/policy/parseNetworkPolicy.js";
import { NetworkFetchError } from "./fetch.js";

export type NetworkServiceProtocol = "http" | "https" | "ws" | "wss";

export type NetworkService = Readonly<{
  id: string;
  name: string;
  purpose: string;
  protocol: NetworkServiceProtocol;
  host: string;
  port: number;
  baseUrl: string;
  source: string;
  enabled: boolean;
}>;

export type NetworkServiceRegistryOptions = {
  model?: ModelConfig;
  env?: Record<string, string | undefined>;
  mcpServers?: readonly PilotDeckMcpServerSpec[];
};

export type NetworkLookup = (
  host: string,
) => Promise<readonly { address: string; family?: number }[]>;

const DEFAULT_PORTS: Readonly<Record<NetworkServiceProtocol, number>> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

const SERVICE_ENVIRONMENT = [
  { id: "service.rag", name: "RAG 服务", purpose: "医学知识检索", keys: ["MED_RAG_SERVICE_API_BASE", "MED_RAG_SERVICE_ENDPOINT", "MED_RAG_SERVICE_HEALTH_ENDPOINT"], defaults: ["http://127.0.0.1:18080"] },
  { id: "service.radar", name: "RADAR 服务", purpose: "腹部 CT 分析", keys: ["MED_RADAR_API_BASE"], defaults: ["https://127.0.0.1:18120"] },
  { id: "service.deepchest", name: "DeepChest 服务", purpose: "胸部 CT 分析", keys: ["MED_DEEPCHEST_API_BASE"] },
  { id: "service.vlm", name: "医学视觉模型", purpose: "医学影像解析", keys: ["MED_VLM_API_BASE", "MED_VLM_FALLBACK_API_BASE"] },
  { id: "service.embedding", name: "Embedding 服务", purpose: "向量化和本地检索", keys: ["MED_EMBEDDING_API_BASE", "MED_EMBEDDING_ENDPOINT"] },
  { id: "service.mineru", name: "MinerU 服务", purpose: "远程文档解析", keys: ["MED_RAG_MINERU_API_BASE"] },
  { id: "service.memory", name: "记忆服务", purpose: "长期记忆模型服务", keys: ["PILOTDECK_MEMORY_BASE_URL", "EDGECLAW_MEMORY_BASE_URL"] },
  { id: "service.office_renderer", name: "Office Renderer", purpose: "Office 文件转换和渲染", keys: ["PILOTDECK_OFFICE_RENDERER_URL"] },
] as const;

function normalizeHost(host: string): string {
  const value = host.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  return value === "localhost" ? "localhost" : value;
}

function protocolFromUrl(url: URL): NetworkServiceProtocol | undefined {
  const protocol = url.protocol.slice(0, -1).toLowerCase();
  return ["http", "https", "ws", "wss"].includes(protocol)
    ? protocol as NetworkServiceProtocol
    : undefined;
}

function portFromUrl(url: URL, protocol: NetworkServiceProtocol): number {
  return url.port ? Number(url.port) : DEFAULT_PORTS[protocol];
}

function normalizeBaseUrl(url: URL): string {
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

function parseServiceUrl(raw: string): {
  url: URL;
  protocol: NetworkServiceProtocol;
  host: string;
  port: number;
} | undefined {
  try {
    const url = new URL(raw.trim());
    const protocol = protocolFromUrl(url);
    if (!protocol || url.username || url.password) return undefined;
    return {
      url,
      protocol,
      host: normalizeHost(url.hostname),
      port: portFromUrl(url, protocol),
    };
  } catch {
    return undefined;
  }
}

function serviceFromUrl(
  id: string,
  name: string,
  purpose: string,
  raw: string,
  source: string,
): NetworkService | undefined {
  const parsed = parseServiceUrl(raw);
  if (!parsed) return undefined;
  return {
    id,
    name,
    purpose,
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    baseUrl: normalizeBaseUrl(parsed.url),
    source,
    enabled: true,
  };
}

function mergeService(
  services: Map<string, NetworkService>,
  candidate: NetworkService,
): void {
  const previous = services.get(candidate.id);
  if (!previous) {
    services.set(candidate.id, candidate);
    return;
  }
  // Several environment variables describe different paths of one service.
  // Keep the first base URL for display while retaining the shared origin.
  if (
    previous.protocol === candidate.protocol
    && previous.host === candidate.host
    && previous.port === candidate.port
  ) {
    return;
  }
  // A fallback endpoint may legitimately point to another node. Keep it as a
  // stable sibling rather than silently changing the primary service address.
  services.set(`${candidate.id}.fallback`, {
    ...candidate,
    id: `${candidate.id}.fallback`,
    name: `${candidate.name}（备用）`,
  });
}

function safeServiceId(prefix: string, value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "_");
  return `${prefix}.${normalized || "unnamed"}`;
}

export function collectNetworkServices(
  options: NetworkServiceRegistryOptions = {},
): NetworkService[] {
  const services = new Map<string, NetworkService>();
  const model = options.model;
  if (model) {
    for (const [providerId, provider] of Object.entries(model.providers)) {
      const service = serviceFromUrl(
        `model.${providerId}`,
        `模型服务：${providerId}`,
        "系统模型请求",
        provider.url,
        `model.providers.${providerId}.url`,
      );
      if (service) mergeService(services, service);
    }
  }

  const env = options.env ?? process.env;
  for (const definition of SERVICE_ENVIRONMENT) {
    const values = definition.keys
      .map((key) => env[key]?.trim())
      .filter((value): value is string => Boolean(value));
    if (values.length === 0 && "defaults" in definition) values.push(...definition.defaults);
    for (const [index, value] of values.entries()) {
      const service = serviceFromUrl(
        definition.id,
        definition.name,
        definition.purpose,
        value,
        `env.${definition.keys[index] ?? definition.keys[0]}`,
      );
      if (service) mergeService(services, service);
    }
  }

  if (
    !services.has("service.office_renderer")
    && env.PILOTDECK_OFFICE_RENDERER_ROLE?.trim().toLowerCase() === "server"
  ) {
    const port = Number.parseInt(env.PILOTDECK_OFFICE_RENDERER_PORT ?? "19400", 10);
    const service = serviceFromUrl(
      "service.office_renderer",
      "Office Renderer",
      "Office 文件转换和渲染",
      `http://127.0.0.1:${Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : 19400}`,
      "env.PILOTDECK_OFFICE_RENDERER_ROLE",
    );
    if (service) mergeService(services, service);
  }

  for (const server of options.mcpServers ?? []) {
    if (server.transport !== "streamable_http") continue;
    const service = serviceFromUrl(
      safeServiceId("mcp", server.id),
      `MCP 服务：${server.id}`,
      "远程 MCP 功能服务",
      server.url,
      `mcp.${server.id}.url`,
    );
    if (service) mergeService(services, service);
  }

  return [...services.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

function ipv4InCidr(address: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split("/");
  if (!base || !bitsText || isIP(address) !== 4 || isIP(base) !== 4) return false;
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) {
    const value = ipv4Number(normalized);
    return (
      (value >>> 24) === 10
      || (value >>> 20) === 0xac1
      || (value >>> 16) === 0xc0a8
      || (value >>> 24) === 127
      || (value >>> 16) === 0xa9fe
    );
  }
  if (isIP(normalized) === 6) {
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb");
  }
  return false;
}

function protocolForTarget(url: URL): NetworkServiceProtocol | undefined {
  return protocolFromUrl(url);
}

function effectiveRule(service: NetworkService, policy: NetworkPolicy): NetworkRule | undefined {
  return policy.rules.find((rule) => rule.id === service.id);
}

export class NetworkServiceRegistry {
  private readonly services = new Map<string, NetworkService>();

  constructor(initial: readonly NetworkService[] = []) {
    for (const service of initial) this.register(service);
  }

  register(service: NetworkService): void {
    this.services.set(service.id, Object.freeze({ ...service }));
  }

  registerFromOptions(options: NetworkServiceRegistryOptions): void {
    for (const service of collectNetworkServices(options)) this.register(service);
  }

  list(policy?: NetworkPolicy): NetworkService[] {
    return [...this.services.values()]
      .map((service) => this.effectiveService(service, policy))
      .filter((service): service is NetworkService => service !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  match(url: URL, policy: NetworkPolicy): NetworkService | undefined {
    const protocol = protocolForTarget(url);
    if (!protocol || url.username || url.password) return undefined;
    const targetHost = normalizeHost(url.hostname);
    const targetPort = url.port ? Number(url.port) : DEFAULT_PORTS[protocol];
    for (const service of this.services.values()) {
      const rule = effectiveRule(service, policy);
      if (rule && !rule.enabled) continue;
      const expectedProtocol = rule?.protocol === "tcp" ? undefined : rule?.protocol ?? service.protocol;
      const expectedPort = rule?.port ?? service.port;
      if (expectedProtocol !== protocol || expectedPort !== targetPort) continue;
      if (rule?.cidr) {
        if (!ipv4InCidr(targetHost, rule.cidr)) continue;
      } else if (normalizeHost(rule?.host ?? service.host) !== targetHost) {
        continue;
      }
      return service;
    }
    return undefined;
  }

  private effectiveService(service: NetworkService, policy?: NetworkPolicy): NetworkService | undefined {
    if (!policy) return service;
    const rule = effectiveRule(service, policy);
    if (rule && !rule.enabled) return undefined;
    if (!rule || rule.cidr) return service;
    const protocol = rule.protocol === "tcp" ? service.protocol : rule.protocol;
    const host = rule.host ?? service.host;
    return {
      ...service,
      protocol,
      host,
      port: rule.port,
      baseUrl: `${protocol}://${host.includes(":") ? `[${host}]` : host}:${rule.port}`,
      enabled: rule.enabled,
    };
  }
}

export type NetworkAccessControllerOptions = {
  registry: NetworkServiceRegistry;
  getPolicy?: () => NetworkPolicy;
  refreshPolicy?: () => Promise<NetworkPolicy>;
  lookup?: NetworkLookup;
  onEvent?: (event: NetworkAccessEvent) => void;
};

export type NetworkAccessEvent = Readonly<{
  type: "allowed" | "denied";
  url: string;
  serviceId?: string;
  reason?: string;
}>;

export class NetworkAccessController {
  private readonly lookup: NetworkLookup;

  constructor(private readonly options: NetworkAccessControllerOptions) {
    this.lookup = options.lookup ?? (async (host) => dnsLookup(host, { all: true, verbatim: true }));
  }

  async assertAllowed(input: string | URL | Request): Promise<NetworkService> {
    let policy: NetworkPolicy | undefined;
    try {
      policy = this.options.refreshPolicy
        ? await this.options.refreshPolicy()
        : this.options.getPolicy?.();
    } catch (error) {
      const message = `Network policy could not be reloaded: ${error instanceof Error ? error.message : String(error)}`;
      this.emit({ type: "denied", url: String(input), reason: message });
      throw new NetworkFetchError("network_policy_denied", message, error);
    }
    if (!policy) {
      throw new NetworkFetchError("network_policy_denied", "Network policy is not configured.");
    }

    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : input);
    } catch (error) {
      throw new NetworkFetchError("network_policy_denied", "Network target is not a valid URL.", error);
    }
    const service = this.options.registry.match(url, policy);
    if (!service) {
      const message = `Network target is not a registered internal service: ${url.origin}.`;
      this.emit({ type: "denied", url: url.toString(), reason: message });
      throw new NetworkFetchError("network_policy_denied", message);
    }

    const addresses = isIP(url.hostname)
      ? [{ address: normalizeHost(url.hostname) }]
      : await this.lookup(url.hostname).catch((error) => {
          throw new NetworkFetchError(
            "network_dns_error",
            `Could not resolve registered network service ${url.hostname}.`,
            error,
          );
        });
    if (addresses.length === 0 || addresses.some(({ address }) => !privateAddress(address))) {
      const message = `Registered service ${service.id} resolved outside the private network.`;
      this.emit({ type: "denied", url: url.toString(), serviceId: service.id, reason: message });
      throw new NetworkFetchError("network_policy_denied", message);
    }

    this.emit({ type: "allowed", url: url.toString(), serviceId: service.id });
    return service;
  }

  listServices(policy?: NetworkPolicy): NetworkService[] {
    return this.options.registry.list(policy);
  }

  registerServices(options: NetworkServiceRegistryOptions): void {
    this.options.registry.registerFromOptions(options);
  }

  private emit(event: NetworkAccessEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Network auditing must never change the decision.
    }
  }
}

