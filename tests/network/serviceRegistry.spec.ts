import assert from "node:assert/strict";
import test from "node:test";
import { networkFetch } from "../../src/network/fetch.js";
import {
  NetworkAccessController,
  NetworkServiceRegistry,
  collectNetworkServices,
  type NetworkService,
} from "../../src/network/serviceRegistry.js";
import type { NetworkPolicy } from "../../src/security/policy/parseNetworkPolicy.js";

function service(overrides: Partial<NetworkService> = {}): NetworkService {
  return {
    id: "service.model",
    name: "本地模型",
    purpose: "模型请求",
    protocol: "http",
    host: "127.0.0.1",
    port: 9000,
    baseUrl: "http://127.0.0.1:9000/v1",
    source: "test",
    enabled: true,
    ...overrides,
  };
}

function policy(rules: NetworkPolicy["rules"] = []): NetworkPolicy {
  return { version: 1 as const, mode: "deny" as const, rules };
}

test("collectNetworkServices registers configured model, medical, renderer, and HTTP MCP services", () => {
  const services = collectNetworkServices({
    model: {
      providers: {
        local: {
          id: "local",
          protocol: "openai",
          url: "http://127.0.0.1:9000/v1",
          apiKey: "test",
          headers: {},
          models: {},
        },
      },
    },
    env: {
      MED_RAG_SERVICE_API_BASE: "http://10.0.0.5:18080",
      PILOTDECK_OFFICE_RENDERER_URL: "http://127.0.0.1:19400",
    },
    mcpServers: [{
      id: "med-tools",
      transport: "streamable_http",
      url: "http://10.0.0.6:18100/mcp",
    }],
  });

  assert.deepEqual(
    services.map((entry) => entry.id),
    ["mcp.med-tools", "model.local", "service.office_renderer", "service.radar", "service.rag"],
  );
  assert.equal(services.find((entry) => entry.id === "service.rag")?.host, "10.0.0.5");
  assert.equal(services.find((entry) => entry.id === "mcp.med-tools")?.port, 18100);
});

test("registered loopback and private remote services are allowed, unknown targets are denied", async () => {
  const registry = new NetworkServiceRegistry([
    service(),
    service({
      id: "service.rag",
      name: "RAG",
      purpose: "检索",
      host: "rag.internal",
      port: 18080,
      baseUrl: "http://rag.internal:18080",
    }),
  ]);
  const access = new NetworkAccessController({
    registry,
    getPolicy: () => policy(),
    lookup: async (host) => host === "rag.internal" ? [{ address: "10.0.0.5", family: 4 }] : [],
  });

  await access.assertAllowed("http://127.0.0.1:9000/v1/chat");
  await access.assertAllowed("http://rag.internal:18080/v1/retrieve");
  await assert.rejects(
    access.assertAllowed("https://example.com/"),
    { code: "network_policy_denied" },
  );
  await assert.rejects(
    access.assertAllowed("http://127.0.0.1:9001/"),
    { code: "network_policy_denied" },
  );
});

test("public DNS results are denied even when the hostname was configured", async () => {
  const access = new NetworkAccessController({
    registry: new NetworkServiceRegistry([service({
      id: "service.remote",
      host: "configured.internal",
      port: 9443,
      baseUrl: "https://configured.internal:9443",
      protocol: "https",
    })]),
    getPolicy: () => policy(),
    lookup: async () => [{ address: "203.0.113.10", family: 4 }],
  });

  await assert.rejects(
    access.assertAllowed("https://configured.internal:9443/health"),
    { code: "network_policy_denied" },
  );
});

test("policy rules can disable or retarget a registered service but cannot add an unknown service", async () => {
  const registry = new NetworkServiceRegistry([service()]);
  const disabled = new NetworkAccessController({
    registry,
    getPolicy: () => policy([{
      id: "service.model",
      enabled: false,
      host: "127.0.0.1",
      port: 9000,
      protocol: "http",
      purpose: "model",
    }]),
  });
  await assert.rejects(disabled.assertAllowed("http://127.0.0.1:9000/"), { code: "network_policy_denied" });

  const retargeted = new NetworkAccessController({
    registry,
    getPolicy: () => policy([{
      id: "service.model",
      enabled: true,
      host: "127.0.0.1",
      port: 9100,
      protocol: "http",
      purpose: "model",
    }, {
      id: "unknown.service",
      enabled: true,
      host: "127.0.0.1",
      port: 9200,
      protocol: "http",
      purpose: "unknown",
    }]),
  });
  await retargeted.assertAllowed("http://127.0.0.1:9100/");
  await assert.rejects(retargeted.assertAllowed("http://127.0.0.1:9000/"), { code: "network_policy_denied" });
  await assert.rejects(retargeted.assertAllowed("http://127.0.0.1:9200/"), { code: "network_policy_denied" });
});

test("networkFetch re-checks every HTTP redirect target", async () => {
  const access = new NetworkAccessController({
    registry: new NetworkServiceRegistry([service()]),
    getPolicy: () => policy(),
  });
  let calls = 0;
  await assert.rejects(
    networkFetch("http://127.0.0.1:9000/start", {}, {
      networkAccess: access,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:9001/unknown" },
        });
      },
    }),
    { code: "network_policy_denied" },
  );
  assert.equal(calls, 1);
});

test("networkFetch follows redirects only when the target remains registered", async () => {
  const access = new NetworkAccessController({
    registry: new NetworkServiceRegistry([service()]),
    getPolicy: () => policy(),
  });
  let calls = 0;
  const response = await networkFetch("http://127.0.0.1:9000/start", {}, {
    networkAccess: access,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 302, headers: { location: "/next" } })
        : new Response("ok", { status: 200 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(await response.text(), "ok");
});
