#!/usr/bin/env node
/**
 * Pre-flight LLM check for start-local.sh.
 *
 * Verifies pilotdeck.yaml exists, has a usable agent.model, then probes every
 * configured chat model under model.providers plus the top-level embedding
 * block (when enabled). Prints ✓ / ✗ per model.
 * Exit 1 if config is missing/unusable or the main agent model cannot connect.
 * An enabled embedding model is probed and reported, but failure only warns.
 *
 * Usage:
 *   node scripts/check-llm-config.mjs [--pilot-home PATH]
 *
 * Env:
 *   PILOT_HOME                        config home (default: <repo>/.pilotdeck-home)
 *   PILOTDECK_LLM_CHECK_TIMEOUT_MS    per-model probe timeout (default 10000)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const PLACEHOLDER_API_KEY = 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE';
const PLACEHOLDER_PROVIDER = '_placeholder';
const OK = '✓';
const BAD = '✗';

const args = process.argv.slice(2);
const pilotHomeArg = args.find((a) => a.startsWith('--pilot-home='))?.split('=')[1]
  ?? (args.includes('--pilot-home') ? args[args.indexOf('--pilot-home') + 1] : null);

function resolvePilotHome() {
  const raw = pilotHomeArg ?? process.env.PILOT_HOME ?? join(
    resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    '.pilotdeck-home',
  );
  return resolve(raw);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseMainRef(mainRef) {
  const text = String(mainRef || '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  return { providerId: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

function normalizeProtocol(protocol) {
  const value = String(protocol || 'openai').toLowerCase();
  if (value === 'anthropic') return 'anthropic';
  if (value === 'google') return 'google';
  if (value === 'openai-responses' || value === 'responses') return 'openai-responses';
  return 'openai';
}

function providerAllowsMissingApiKey(providerId) {
  return providerId === 'ollama';
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

/** Minimal endpoint candidates (mirrors src/model/providerEndpoint.ts for probes). */
function chatEndpointCandidates(protocol, baseUrl, model) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return [];
  const hasVersion = /\/v\d+(?:beta\d*)?$/i.test(base);

  if (protocol === 'anthropic') {
    return unique(hasVersion
      ? [joinUrl(base, 'messages')]
      : [joinUrl(base, 'v1/messages'), joinUrl(base, 'messages')]);
  }
  if (protocol === 'openai-responses') {
    return unique(hasVersion
      ? [joinUrl(base, 'responses')]
      : [joinUrl(base, 'v1/responses'), joinUrl(base, 'responses')]);
  }
  if (protocol === 'google') {
    const encoded = encodeURIComponent(String(model || '').trim());
    return unique(hasVersion
      ? [joinUrl(base, `models/${encoded}:generateContent`)]
      : [
        joinUrl(base, `v1beta/models/${encoded}:generateContent`),
        joinUrl(base, `models/${encoded}:generateContent`),
      ]);
  }
  return unique(hasVersion
    ? [joinUrl(base, 'chat/completions')]
    : [joinUrl(base, 'v1/chat/completions'), joinUrl(base, 'chat/completions')]);
}

function unique(urls) {
  return [...new Set(urls.filter(Boolean))];
}

function isUsableProvider(providerId, provider, modelId) {
  if (!provider || typeof provider !== 'object') return { ok: false, reason: 'provider missing' };
  if (providerId === PLACEHOLDER_PROVIDER) {
    return { ok: false, reason: 'placeholder provider — ship a real pilotdeck.yaml' };
  }
  const url = typeof provider.url === 'string' ? provider.url.trim() : '';
  if (!url) return { ok: false, reason: 'missing url' };
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
  if (apiKey === PLACEHOLDER_API_KEY) {
    return { ok: false, reason: 'placeholder apiKey — replace with a real credential' };
  }
  if (!providerAllowsMissingApiKey(providerId) && !apiKey) {
    return { ok: false, reason: 'missing apiKey' };
  }
  const models = provider.models && typeof provider.models === 'object' ? provider.models : null;
  if (!models || !(modelId in models)) {
    return { ok: false, reason: `model "${modelId}" not listed under providers.${providerId}.models` };
  }
  return { ok: true };
}

function buildProbeRequest(protocol, baseUrl, apiKey, model) {
  const urls = chatEndpointCandidates(protocol, baseUrl, model);

  if (protocol === 'google') {
    return {
      urls,
      options: {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 8 },
        }),
      },
      validate: (body) => Array.isArray(body?.candidates),
    };
  }

  if (protocol === 'anthropic') {
    return {
      urls,
      options: {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      },
      validate: (body) => Array.isArray(body?.content) || body?.type === 'message',
    };
  }

  if (protocol === 'openai-responses') {
    return {
      urls,
      options: {
        method: 'POST',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_output_tokens: 16,
          input: 'Hi',
          store: false,
        }),
      },
      validate: (body) =>
        body?.object === 'response'
        || Array.isArray(body?.output)
        || typeof body?.output_text === 'string',
    };
  }

  return {
    urls,
    options: {
      method: 'POST',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply exactly: OK' }],
      }),
    },
    validate: (body) => Array.isArray(body?.choices),
  };
}

async function probeModel({ providerId, modelId, provider, timeoutMs }) {
  const protocol = normalizeProtocol(provider.protocol);
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
  const { urls, options, validate } = buildProbeRequest(protocol, provider.url, apiKey, modelId);
  let lastError = 'no endpoint candidates';

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      clearTimeout(timer);
      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          const body = JSON.parse(text);
          if (body?.error?.message) detail = body.error.message;
        } catch {
          // keep status text
        }
        lastError = detail;
        continue;
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        lastError = `non-JSON response from ${url}`;
        continue;
      }
      if (!validate(body)) {
        lastError = `unexpected response shape from ${url}`;
        continue;
      }
      return { ok: true, url };
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') {
        lastError = `timeout after ${Math.round(timeoutMs / 1000)}s`;
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  return { ok: false, error: lastError };
}

function collectChatTargets(config) {
  const providers = config?.model?.providers;
  if (!providers || typeof providers !== 'object') return [];
  const targets = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    const models = provider?.models && typeof provider.models === 'object' ? provider.models : {};
    for (const modelId of Object.keys(models)) {
      targets.push({ kind: 'chat', providerId, modelId, provider });
    }
  }
  return targets;
}

function collectEmbeddingTarget(config) {
  const embedding = config?.embedding;
  if (!embedding || typeof embedding !== 'object') return null;
  if (embedding.enabled === false) return null;

  const modelId = typeof embedding.model === 'string' ? embedding.model.trim() : '';
  const endpoint = typeof embedding.endpoint === 'string' ? embedding.endpoint.trim() : '';
  const apiBase = typeof embedding.apiBase === 'string' ? embedding.apiBase.trim() : '';
  const apiKey = typeof embedding.apiKey === 'string' ? embedding.apiKey.trim() : '';

  if (!modelId && !endpoint && !apiBase) return null;

  return {
    kind: 'embedding',
    providerId: 'embedding',
    modelId: modelId || '(missing-model)',
    embedding: {
      model: modelId,
      endpoint,
      apiBase,
      apiKey,
      enabled: embedding.enabled !== false,
    },
  };
}

function embeddingEndpointCandidates(embedding) {
  const endpoints = [];
  if (embedding.endpoint) {
    endpoints.push(embedding.endpoint.replace(/\/+$/, ''));
  }
  if (embedding.apiBase) {
    const base = embedding.apiBase.replace(/\/+$/, '');
    const hasVersion = /\/v\d+(?:beta\d*)?$/i.test(base);
    endpoints.push(hasVersion ? joinUrl(base, 'embeddings') : joinUrl(base, 'v1/embeddings'));
    endpoints.push(joinUrl(base, 'embeddings'));
  }
  return unique(endpoints);
}

function isUsableEmbedding(embedding) {
  if (!embedding.model) return { ok: false, reason: 'embedding.model missing' };
  if (!embedding.endpoint && !embedding.apiBase) {
    return { ok: false, reason: 'embedding.endpoint or embedding.apiBase required' };
  }
  if (embedding.apiKey === PLACEHOLDER_API_KEY) {
    return { ok: false, reason: 'placeholder apiKey — replace with a real credential' };
  }
  // Local services often use EMPTY / any non-empty token; empty key is allowed.
  return { ok: true };
}

async function probeEmbedding({ embedding, timeoutMs }) {
  const urls = embeddingEndpointCandidates(embedding);
  let lastError = 'no embedding endpoint candidates';

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...(embedding.apiKey ? { Authorization: `Bearer ${embedding.apiKey}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: embedding.model,
          input: 'ping',
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      clearTimeout(timer);
      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          const body = JSON.parse(text);
          if (body?.error?.message) detail = body.error.message;
        } catch {
          // keep status text
        }
        lastError = detail;
        continue;
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        lastError = `non-JSON response from ${url}`;
        continue;
      }
      const vector = body?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        lastError = `unexpected embeddings response shape from ${url}`;
        continue;
      }
      return { ok: true, url, dimension: vector.length };
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') {
        lastError = `timeout after ${Math.round(timeoutMs / 1000)}s`;
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  return { ok: false, error: lastError };
}

async function main() {
  const pilotHome = resolvePilotHome();
  const configPath = join(pilotHome, 'pilotdeck.yaml');
  const timeoutMs = Number.parseInt(process.env.PILOTDECK_LLM_CHECK_TIMEOUT_MS || '10000', 10) || 10000;

  console.log('==> LLM_CHECK');
  console.log(`    config: ${configPath}`);

  if (!existsSync(configPath)) {
    fail(`pilotdeck.yaml not found at ${configPath}. Provide a preconfigured yaml before start-local.`);
  }

  let config;
  try {
    config = parseYaml(readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const mainRef = typeof config?.agent?.model === 'string' ? config.agent.model.trim() : '';
  const main = parseMainRef(mainRef);
  if (!main) {
    fail('agent.model must be set as "providerId/modelId" in pilotdeck.yaml');
  }

  const mainProvider = config?.model?.providers?.[main.providerId];
  const usable = isUsableProvider(main.providerId, mainProvider, main.modelId);
  if (!usable.ok) {
    fail(`main agent ${main.providerId}/${main.modelId}: ${usable.reason}`);
  }

  const chatTargets = collectChatTargets(config);
  const embeddingTarget = collectEmbeddingTarget(config);
  if (chatTargets.length === 0) {
    fail('no models found under model.providers');
  }

  const totalProbes = chatTargets.length + (embeddingTarget ? 1 : 0);
  console.log(`    agent:  ${main.providerId}/${main.modelId}`);
  if (embeddingTarget) {
    console.log(`    embed:  ${embeddingTarget.modelId}`);
  }
  console.log(`    probe:  ${totalProbes} model(s), timeout ${timeoutMs}ms each`);
  console.log('');

  let mainOk = false;
  let failedCount = 0;

  for (const target of chatTargets) {
    const label = `${target.providerId}/${target.modelId}`;
    const isMain = target.providerId === main.providerId && target.modelId === main.modelId;
    const configCheck = isUsableProvider(target.providerId, target.provider, target.modelId);
    if (!configCheck.ok) {
      failedCount += 1;
      console.log(`  ${BAD} ${label}${isMain ? '  (main agent)' : ''}`);
      console.log(`      ${configCheck.reason}`);
      continue;
    }

    const result = await probeModel({ ...target, timeoutMs });
    if (result.ok) {
      if (isMain) mainOk = true;
      console.log(`  ${OK} ${label}${isMain ? '  (main agent)' : ''}`);
    } else {
      failedCount += 1;
      console.log(`  ${BAD} ${label}${isMain ? '  (main agent)' : ''}`);
      console.log(`      ${result.error}`);
    }
  }

  if (embeddingTarget) {
    const label = `embedding/${embeddingTarget.modelId}`;
    const configCheck = isUsableEmbedding(embeddingTarget.embedding);
    if (!configCheck.ok) {
      failedCount += 1;
      console.log(`  ${BAD} ${label}  (embedding)`);
      console.log(`      ${configCheck.reason}`);
    } else {
      const result = await probeEmbedding({
        embedding: embeddingTarget.embedding,
        timeoutMs,
      });
      if (result.ok) {
        const dimNote = result.dimension ? `  dim=${result.dimension}` : '';
        console.log(`  ${OK} ${label}  (embedding)${dimNote}`);
      } else {
        failedCount += 1;
        console.log(`  ${BAD} ${label}  (embedding)`);
        console.log(`      ${result.error}`);
      }
    }
  }

  console.log('');
  if (!mainOk) {
    fail(
      `main agent model ${main.providerId}/${main.modelId} is not reachable. Fix pilotdeck.yaml / network, or set SKIP_LLM_CHECK=1 to bypass (not recommended).`,
    );
  }

  if (failedCount > 0) {
    console.log(`    LLM_CHECK passed (main agent OK); ${failedCount} other model(s) failed — startup continues.`);
  } else {
    console.log('    LLM_CHECK passed — all configured models reachable.');
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
