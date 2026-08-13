/**
 * Medical customer preset loader and validator.
 *
 * Reads versioned YAML manifests from `customer-presets/` and exposes a
 * merged runtime preset that feeds branding, feature flags, profile defaults,
 * knowledge corpus defaults, security policy, and deployment metadata to the
 * medical API and UI.
 *
 * Selection order:
 *  1. PILOTDECK_MEDICAL_CUSTOMER_PRESET env var (e.g. "offline-military")
 *  2. PILOTDECK_MEDICAL_PRESET_DIR env var (custom path to a preset directory)
 *  3. Default: first preset found under the feature-pack `customer-presets/`
 *     that is not `_template`
 *
 * The `_template` preset is always loadable via `?preset=_template` on
 * health/config endpoints but never selected by default.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const FEATURE_PACK_ROOT = resolve(
  import.meta.dirname ?? '.',
  '..',  // services/
  '..',  // server/
  '..',  // ui/
  '..',  // repo root
  'products',
  'medical-integration',
);

const DEFAULT_PRESETS_DIR = join(FEATURE_PACK_ROOT, 'customer-presets');

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const VALID_FEATURE_KEYS = new Set([
  'dialogue',
  'medTrauma',
  'reportInterpretation',
  'medicinePackageRecognition',
  'deepSearch',
  'tableDigitization',
  'attachmentIngestion',
  'dicomPreview',
  'ecgPreview',
  'gallery3d',
  'volume',
  'm3d',
  'feishu',
]);

const VALID_SECURITY_KEYS = new Set([
  'crossSessionMemory',
  'publicWebSearch',
  'externalTelemetry',
  'requireHumanReview',
  'phiStorage',
  'dicomBurnedInClearanceRequired',
]);

const VALID_OFFLINE_LEVELS = new Set(['L0', 'L1', 'L2', 'L3', 'L4']);
const VALID_PHI_STORAGE = new Set(['temporary-ttl', 'filesystem', 'disabled']);

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {asserts value is Record<string, unknown>}
 */
function assertObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MEDICAL_PRESET_INVALID: ${path} must be an object`);
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function assertString(value, path) {
  if (typeof value !== 'string') {
    throw new Error(`MEDICAL_PRESET_INVALID: ${path} must be a string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {boolean}
 */
function assertBoolean(value, path) {
  if (typeof value !== 'boolean') {
    throw new Error(`MEDICAL_PRESET_INVALID: ${path} must be a boolean`);
  }
  return value;
}

/**
 * Parse a single manifest YAML string into a validated preset object.
 * This is a minimal YAML parser for the flat/one-level-deep structure of
 * manifest.yaml.  It does NOT handle anchors, references, multi-line
 * strings, or complex nesting beyond what the schema uses.
 *
 * @param {string} raw
 * @param {string} presetId
 * @returns {object}
 */
function parseManifestYaml(raw, presetId) {
  const lines = raw.split(/\r?\n/);
  const root = {};
  let currentSection = null;
  let currentIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    // Skip comment-only and blank lines
    if (/^\s*(#|$)/.test(trimmed)) continue;

    const indent = line.search(/\S/);
    const content = trimmed;

    // Top-level key (no indent)
    if (indent === 0 && content.includes(':')) {
      const colon = content.indexOf(':');
      const key = content.slice(0, colon).trim();
      const value = content.slice(colon + 1).trim();

      if (value === '' || value === '{}' || value === '[]') {
        // Section header — next indented lines belong to this section
        currentSection = key;
        currentIndent = 0;
        root[key] = value === '[]' ? [] : {};
      } else if (value === 'null') {
        root[key] = null;
        currentSection = null;
      } else {
        root[key] = parseScalar(value);
        currentSection = null;
      }
      continue;
    }

    // Indented key under current section
    if (indent > 0 && currentSection !== null) {
      const colon = content.indexOf(':');
      if (colon === -1) continue;
      const key = content.slice(0, colon).trim();
      const value = content.slice(colon + 1).trim();

      if (Array.isArray(root[currentSection])) {
        root[currentSection].push(parseScalar(key.startsWith('- ') ? key.slice(2) : key));
      } else {
        root[currentSection][key] =
          value === 'null' || value === '' ? null : parseScalar(value);
      }
    }
  }

  return validateManifest(root, presetId);
}

function parseScalar(value) {
  const v = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} presetId
 * @returns {object}
 */
function validateManifest(raw, presetId) {
  if (raw.schemaVersion !== 1) {
    throw new Error(
      `MEDICAL_PRESET_INVALID: unsupported schemaVersion ${raw.schemaVersion} in preset "${presetId}"`,
    );
  }

  // customer
  assertObject(raw.customer, 'customer');
  const customerId = assertString(raw.customer.id, 'customer.id');
  const displayName = assertString(raw.customer.displayName, 'customer.displayName');

  // branding
  assertObject(raw.branding, 'branding');
  const branding = {
    productName: assertString(raw.branding.productName, 'branding.productName'),
    dialogueName: raw.branding.dialogueName ?? null,
    traumaName: raw.branding.traumaName ?? null,
    organizationName: raw.branding.organizationName ?? null,
    logoAsset: raw.branding.logoAsset ?? null,
  };

  // features
  assertObject(raw.features, 'features');
  /** @type {Record<string, boolean>} */
  const features = {};
  for (const [key, value] of Object.entries(raw.features)) {
    if (!VALID_FEATURE_KEYS.has(key)) {
      throw new Error(`MEDICAL_PRESET_INVALID: unknown feature "${key}" in preset "${presetId}"`);
    }
    features[key] = assertBoolean(value, `features.${key}`);
  }
  // Default unknown features to false
  for (const key of VALID_FEATURE_KEYS) {
    if (!(key in features)) features[key] = false;
  }

  // profiles
  assertObject(raw.profiles, 'profiles');
  const profiles = {
    defaultDialogue: raw.profiles.defaultDialogue ?? 'medical-general',
    report: raw.profiles.report ?? 'medical-report',
    trauma: raw.profiles.trauma ?? 'war-trauma-assessment',
    deepSearch: raw.profiles.deepSearch ?? 'medical-deep-search',
  };

  // knowledge
  const knowledge = { enabledCorpora: ['war-trauma'], defaultCorpus: 'war-trauma', corpusVersion: null };
  if (raw.knowledge) {
    assertObject(raw.knowledge, 'knowledge');
    if (Array.isArray(raw.knowledge.enabledCorpora)) {
      knowledge.enabledCorpora = raw.knowledge.enabledCorpora.map((c) => String(c));
    }
    if (raw.knowledge.defaultCorpus) {
      knowledge.defaultCorpus = String(raw.knowledge.defaultCorpus);
    }
    if (raw.knowledge.corpusVersion) {
      knowledge.corpusVersion = String(raw.knowledge.corpusVersion);
    }
  }

  // security
  const security = {
    crossSessionMemory: false,
    publicWebSearch: false,
    externalTelemetry: false,
    requireHumanReview: true,
    phiStorage: 'temporary-ttl',
    dicomBurnedInClearanceRequired: false,
  };
  if (raw.security) {
    assertObject(raw.security, 'security');
    for (const [key, value] of Object.entries(raw.security)) {
      if (!VALID_SECURITY_KEYS.has(key)) {
        throw new Error(`MEDICAL_PRESET_INVALID: unknown security key "${key}" in preset "${presetId}"`);
      }
    }
    if ('crossSessionMemory' in raw.security) security.crossSessionMemory = Boolean(raw.security.crossSessionMemory);
    if ('publicWebSearch' in raw.security) security.publicWebSearch = Boolean(raw.security.publicWebSearch);
    if ('externalTelemetry' in raw.security) security.externalTelemetry = Boolean(raw.security.externalTelemetry);
    if ('requireHumanReview' in raw.security) security.requireHumanReview = Boolean(raw.security.requireHumanReview);
    if (raw.security.phiStorage) {
      const v = String(raw.security.phiStorage);
      if (!VALID_PHI_STORAGE.has(v)) {
        throw new Error(`MEDICAL_PRESET_INVALID: unknown phiStorage "${v}" in preset "${presetId}"`);
      }
      security.phiStorage = v;
    }
    if ('dicomBurnedInClearanceRequired' in raw.security) {
      security.dicomBurnedInClearanceRequired = Boolean(raw.security.dicomBurnedInClearanceRequired);
    }
  }

  // deployment
  const deployment = {
    offlineLevel: 'L2',
    medicalSidecarUrl: 'http://127.0.0.1:8765/',
    medicalMcpUrl: 'http://127.0.0.1:8766/mcp',
    composeFile: null,
  };
  if (raw.deployment) {
    assertObject(raw.deployment, 'deployment');
    if (raw.deployment.offlineLevel) {
      const lvl = String(raw.deployment.offlineLevel);
      if (!VALID_OFFLINE_LEVELS.has(lvl)) {
        throw new Error(`MEDICAL_PRESET_INVALID: unknown offlineLevel "${lvl}"`);
      }
      deployment.offlineLevel = lvl;
    }
    if (raw.deployment.medicalSidecarUrl) {
      deployment.medicalSidecarUrl = String(raw.deployment.medicalSidecarUrl);
    }
    if (raw.deployment.medicalMcpUrl) {
      deployment.medicalMcpUrl = String(raw.deployment.medicalMcpUrl);
    }
    if (raw.deployment.composeFile) {
      deployment.composeFile = String(raw.deployment.composeFile);
    }
  }

  return {
    schemaVersion: 1,
    customer: { id: customerId, displayName },
    branding,
    features,
    profiles,
    knowledge,
    security,
    deployment,
  };
}

// ---------------------------------------------------------------------------
// Preset registry
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
let _presetCache = null;

/**
 * Load all presets from the customer-presets directory.
 * @param {string} [presetsDir]
 * @returns {Map<string, object>}
 */
function loadPresets(presetsDir = DEFAULT_PRESETS_DIR) {
  if (_presetCache) return _presetCache;

  const cache = new Map();
  if (!existsSync(presetsDir)) {
    _presetCache = cache;
    return cache;
  }

  const { readdirSync } = require('node:fs');
  const entries = readdirSync(presetsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(presetsDir, entry.name, 'manifest.yaml');
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      const preset = parseManifestYaml(raw, entry.name);
      cache.set(entry.name, preset);
    } catch (err) {
      console.error(`[medicalPreset] Failed to load preset "${entry.name}": ${err.message}`);
      // Continue loading other presets — a broken preset shouldn't crash startup.
    }
  }

  _presetCache = cache;
  return cache;
}

/**
 * Clear the preset cache (for testing / hot-reload).
 */
export function clearPresetCache() {
  _presetCache = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the active preset.
 *
 * @returns {{ preset: object, id: string } | null}
 */
export function resolveActivePreset() {
  const presets = loadPresets();

  // 1. Explicit env var
  const envPreset = process.env.PILOTDECK_MEDICAL_CUSTOMER_PRESET;
  if (envPreset) {
    const preset = presets.get(envPreset);
    if (preset) return { preset, id: envPreset };
    console.warn(`[medicalPreset] PILOTDECK_MEDICAL_CUSTOMER_PRESET="${envPreset}" not found, falling back.`);
  }

  // 2. First non-template preset alphabetically
  const ids = [...presets.keys()].filter((id) => id !== '_template').sort();
  if (ids.length > 0) {
    return { preset: presets.get(ids[0]), id: ids[0] };
  }

  // 3. Fall back to _template
  const template = presets.get('_template');
  if (template) return { preset: template, id: '_template' };

  return null;
}

/**
 * Get a specific preset by id. Returns null if not found.
 * @param {string} id
 * @returns {object | null}
 */
export function getPresetById(id) {
  const presets = loadPresets();
  return presets.get(id) ?? null;
}

/**
 * List all available preset ids (excluding _template by default).
 * @param {{ includeTemplate?: boolean }} [opts]
 * @returns {string[]}
 */
export function listPresetIds(opts = {}) {
  const presets = loadPresets();
  const ids = [...presets.keys()];
  if (!opts.includeTemplate) {
    return ids.filter((id) => id !== '_template');
  }
  return ids;
}

/**
 * Build the health/config info blob for the active preset.
 * Merges active preset with optional overrides.
 * @returns {object}
 */
export function getMedicalPresetInfo() {
  const active = resolveActivePreset();
  if (!active) {
    return {
      presetId: null,
      branding: {
        productName: 'PilotDeck Medical',
        dialogueName: 'Medical Dialogue',
        traumaName: 'Medical Trauma Assessment',
      },
      features: Object.fromEntries([...VALID_FEATURE_KEYS].map((k) => [k, true])),
      security: {
        crossSessionMemory: false,
        publicWebSearch: false,
        externalTelemetry: false,
        requireHumanReview: true,
        phiStorage: 'temporary-ttl',
      },
      deployment: { offlineLevel: 'L1' },
    };
  }

  const { preset, id } = active;
  return {
    presetId: id,
    customer: preset.customer,
    branding: preset.branding,
    features: preset.features,
    profiles: preset.profiles,
    knowledge: preset.knowledge,
    security: preset.security,
    deployment: preset.deployment,
  };
}

/**
 * Boolean check: is a feature enabled in the active preset?
 * @param {string} feature
 * @returns {boolean}
 */
export function isFeatureEnabled(feature) {
  const info = getMedicalPresetInfo();
  return Boolean(info.features?.[feature]);
}
