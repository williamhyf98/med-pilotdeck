import {
  constants as fsConstants,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  access,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATA_ROOT = resolveDefaultDataRoot();
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_CASE_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_ASSET_EXTENSIONS = new Set(['.json', '.png', '.jpg', '.jpeg', '.webp']);
const IMAGE_CONTENT_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

export class MedicalStaticDataError extends Error {
  constructor(code, status = 503, reason = 'not_configured') {
    super('Medical static data is unavailable.');
    this.name = 'MedicalStaticDataError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

export class MedicalStaticDataReader {
  constructor(options = {}) {
    this.dataRoot = path.resolve(
      options.dataRoot
      ?? process.env.PILOTDECK_MEDICAL_DATA_ROOT
      ?? DEFAULT_DATA_ROOT,
    );
    this.demoRootOverride = options.demoRoot ? path.resolve(options.demoRoot) : null;
    this.imageRootOverride = options.imageRoot ? path.resolve(options.imageRoot) : null;
  }

  describe() {
    const demoRoot = this.findDemoRootSync();
    const imageRoot = this.findImageRootSync();
    return {
      configured: demoRoot !== null || imageRoot !== null,
      demoAvailable: demoRoot !== null && isReadableFileSync(path.join(demoRoot, 'index.json')),
      imagesAvailable: imageRoot !== null,
      source: 'local-static-assets',
      historicalEvaluation: true,
    };
  }

  async readDemoIndex() {
    const root = await this.requireDemoRoot();
    return readJsonFile(path.join(root, 'index.json'), root, MAX_INDEX_BYTES);
  }

  async readDemoCase(caseId) {
    const id = requireSafeId(caseId, 'case');
    const root = await this.requireDemoRoot();
    const directCandidates = [
      `${id}.json`,
      path.posix.join(id, 'index.json'),
      path.posix.join(id, 'case.json'),
    ];
    for (const relative of directCandidates) {
      const candidate = await resolveReadableUnderRoot(root, relative, { required: false });
      if (candidate) return readJsonFile(candidate, root, MAX_CASE_BYTES);
    }

    const index = await this.readDemoIndex();
    const reference = findCaseReference(index, id);
    if (!reference) {
      throw new MedicalStaticDataError('MEDICAL_DEMO_CASE_NOT_FOUND', 404, 'not_found');
    }
    const candidate = await resolveReadableUnderRoot(root, reference, { required: false });
    if (!candidate || path.extname(candidate).toLowerCase() !== '.json') {
      throw new MedicalStaticDataError('MEDICAL_DEMO_CASE_NOT_FOUND', 404, 'not_found');
    }
    return readJsonFile(candidate, root, MAX_CASE_BYTES);
  }

  async readDemoAsset(relativePath) {
    const root = await this.requireDemoRoot();
    return readStaticAsset(root, relativePath);
  }

  async readTraumaImage(relativePath) {
    const root = await this.requireImageRoot();
    const normalized = String(relativePath || '')
      .replace(/^\/+/, '')
      .replace(/^war_trauma\//i, '');
    return readStaticAsset(root, normalized, { imagesOnly: true });
  }

  async requireDemoRoot() {
    const root = await this.findDemoRoot();
    if (!root) {
      throw new MedicalStaticDataError(
        'MEDICAL_DEMO_DATA_UNAVAILABLE',
        503,
        'assets_not_installed',
      );
    }
    return root;
  }

  async requireImageRoot() {
    const root = await this.findImageRoot();
    if (!root) {
      throw new MedicalStaticDataError(
        'MEDICAL_DEMO_IMAGES_UNAVAILABLE',
        503,
        'assets_not_installed',
      );
    }
    return root;
  }

  findDemoRootSync() {
    return firstExistingDirectorySync(this.demoCandidates());
  }

  findImageRootSync() {
    return firstExistingDirectorySync(this.imageCandidates());
  }

  async findDemoRoot() {
    return firstExistingDirectory(this.demoCandidates());
  }

  async findImageRoot() {
    return firstExistingDirectory(this.imageCandidates());
  }

  demoCandidates() {
    return uniquePaths([
      this.demoRootOverride,
      path.join(this.dataRoot, 'med-trauma', 'compare_eval_demo10'),
      path.join(this.dataRoot, 'compare_eval_demo10'),
      path.join(this.dataRoot, 'static', 'med-trauma', 'data', 'compare_eval_demo10'),
    ]);
  }

  imageCandidates() {
    return uniquePaths([
      this.imageRootOverride,
      path.join(this.dataRoot, 'med-trauma', 'war_trauma'),
      path.join(this.dataRoot, 'war_trauma'),
      path.join(this.dataRoot, 'static', 'med-trauma', 'war_trauma'),
    ]);
  }
}

async function readJsonFile(filename, allowedRoot, maxBytes) {
  const resolved = await resolveReadableUnderRoot(allowedRoot, path.relative(allowedRoot, filename));
  const info = await stat(resolved);
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) {
    throw new MedicalStaticDataError('MEDICAL_STATIC_DATA_INVALID', 422, 'invalid_asset');
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch {
    throw new MedicalStaticDataError('MEDICAL_STATIC_DATA_INVALID', 422, 'invalid_json');
  }
  return sanitizeStaticValue(parsed);
}

async function readStaticAsset(root, relativePath, options = {}) {
  const normalized = normalizeRelativeAssetPath(relativePath);
  const extension = path.extname(normalized).toLowerCase();
  if (!SAFE_ASSET_EXTENSIONS.has(extension) || (options.imagesOnly && !IMAGE_CONTENT_TYPES[extension])) {
    throw new MedicalStaticDataError('MEDICAL_STATIC_ASSET_UNSUPPORTED', 415, 'unsupported_type');
  }
  const filename = await resolveReadableUnderRoot(root, normalized, { required: false });
  if (!filename) {
    throw new MedicalStaticDataError('MEDICAL_STATIC_ASSET_NOT_FOUND', 404, 'not_found');
  }
  const info = await stat(filename);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ASSET_BYTES) {
    throw new MedicalStaticDataError('MEDICAL_STATIC_DATA_INVALID', 422, 'invalid_asset');
  }
  const data = await readFile(filename);
  if (extension === '.json') {
    let parsed;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      throw new MedicalStaticDataError('MEDICAL_STATIC_DATA_INVALID', 422, 'invalid_json');
    }
    return {
      kind: 'json',
      contentType: 'application/json; charset=utf-8',
      value: sanitizeStaticValue(parsed),
    };
  }
  assertImageSignature(data, extension);
  return {
    kind: 'binary',
    contentType: IMAGE_CONTENT_TYPES[extension],
    value: data,
  };
}

async function resolveReadableUnderRoot(root, relativePath, options = {}) {
  const normalized = normalizeRelativeAssetPath(relativePath);
  const rootReal = await realpath(root);
  const candidate = path.resolve(rootReal, ...normalized.split('/'));
  if (!isWithin(rootReal, candidate)) {
    throw new MedicalStaticDataError('MEDICAL_STATIC_PATH_INVALID', 400, 'invalid_path');
  }
  try {
    await access(candidate, fsConstants.R_OK);
    const candidateReal = await realpath(candidate);
    if (!isWithin(rootReal, candidateReal)) {
      throw new MedicalStaticDataError('MEDICAL_STATIC_PATH_INVALID', 400, 'invalid_path');
    }
    return candidateReal;
  } catch (error) {
    if (error instanceof MedicalStaticDataError) throw error;
    if (options.required === false) return null;
    throw new MedicalStaticDataError('MEDICAL_STATIC_ASSET_NOT_FOUND', 404, 'not_found');
  }
}

function normalizeRelativeAssetPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (
    !raw
    || raw.length > 500
    || raw.startsWith('/')
    || /^[A-Za-z]:/.test(raw)
    || raw.includes('\u0000')
  ) {
    throw new MedicalStaticDataError('MEDICAL_STATIC_PATH_INVALID', 400, 'invalid_path');
  }
  const parts = raw.split('/');
  if (
    parts.length > 12
    || parts.some((part) => !part || part === '.' || part === '..' || part.length > 160)
  ) {
    throw new MedicalStaticDataError('MEDICAL_STATIC_PATH_INVALID', 400, 'invalid_path');
  }
  return parts.join('/');
}

function findCaseReference(value, caseId, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 2_000)) {
      const match = findCaseReference(item, caseId, depth + 1);
      if (match) return match;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const ids = [value.id, value.caseId, value.case_id, value.name]
    .filter((candidate) => typeof candidate === 'string');
  if (ids.includes(caseId)) {
    for (const key of ['file', 'path', 'json', 'caseFile', 'case_file', 'data', 'bundle']) {
      const reference = value[key];
      if (typeof reference === 'string' && reference.toLowerCase().endsWith('.json')) {
        try {
          const relative = reference
            .replace(/^\/+/, '')
            .replace(/^data\/compare_eval_demo10\//i, '');
          return normalizeRelativeAssetPath(relative);
        } catch {
          return '';
        }
      }
    }
  }
  for (const child of Object.values(value)) {
    const match = findCaseReference(child, caseId, depth + 1);
    if (match) return match;
  }
  return '';
}

function sanitizeStaticValue(value, depth = 0, key = '') {
  if (depth > 16) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const imageReference = rewriteTraumaImageReference(value, key);
    if (imageReference) return imageReference;
    if (looksLikeAbsolutePath(value) || looksLikeSecret(value)) return null;
    return value.slice(0, 200_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5_000).map((item) => sanitizeStaticValue(item, depth + 1, key));
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 2_000)) {
      if (/(?:api[_-]?key|authorization|password|secret|token)$/i.test(key)) continue;
      const sanitized = sanitizeStaticValue(child, depth + 1, key);
      if (sanitized !== null || child === null) result[String(key).slice(0, 160)] = sanitized;
    }
    return result;
  }
  return null;
}

function assertImageSignature(data, extension) {
  const valid = (
    (extension === '.png' && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || ((extension === '.jpg' || extension === '.jpeg') && data[0] === 0xff && data[1] === 0xd8)
    || (
      extension === '.webp'
      && data.subarray(0, 4).toString('ascii') === 'RIFF'
      && data.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  );
  if (!valid) {
    throw new MedicalStaticDataError('MEDICAL_STATIC_DATA_INVALID', 422, 'invalid_image');
  }
}

function firstExistingDirectorySync(candidates) {
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isDirectory()) continue;
      return realpathSync(candidate);
    } catch {
      // Try the next allowlisted candidate.
    }
  }
  return null;
}

async function firstExistingDirectory(candidates) {
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isDirectory()) continue;
      return await realpath(candidate);
    } catch {
      // Try the next allowlisted candidate.
    }
  }
  return null;
}

function isReadableFileSync(filename) {
  try {
    return statSync(filename).isFile();
  } catch {
    return false;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireSafeId(value, label) {
  const id = String(value || '').trim();
  if (!SAFE_ID.test(id)) {
    throw new MedicalStaticDataError(
      `MEDICAL_DEMO_${label.toUpperCase()}_INVALID`,
      400,
      'invalid_id',
    );
  }
  return id;
}

function uniquePaths(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
}

function looksLikeAbsolutePath(value) {
  return (
    /^[A-Za-z]:[\\/]/.test(value)
    || /^\/(?:home|users?|tmp|var|etc|opt|local_data|slow_share|ultrafast_share)(?:\/|$)/i.test(value)
  );
}

function looksLikeSecret(value) {
  return /(?:bearer\s+[A-Za-z0-9._-]{12,}|(?:api[_-]?key|password|secret)\s*[:=])/i.test(value);
}

function rewriteTraumaImageReference(value, key) {
  if (
    !/(?:image|preview|thumbnail|src|url|path)/i.test(key)
    && !/(?:^|\/)war_trauma\//i.test(value)
  ) {
    return '';
  }
  const normalized = value.replace(/\\/g, '/');
  const marker = normalized.toLowerCase().lastIndexOf('/war_trauma/');
  const relative = marker >= 0
    ? normalized.slice(marker + '/war_trauma/'.length)
    : normalized.replace(/^\/?war_trauma\//i, '');
  if (!relative || relative === normalized) return '';
  try {
    const safe = normalizeRelativeAssetPath(relative);
    if (!IMAGE_CONTENT_TYPES[path.extname(safe).toLowerCase()]) return '';
    return `/api/medical/demo/images/${safe
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`;
  } catch {
    return '';
  }
}

function resolveDefaultDataRoot() {
  try {
    return fileURLToPath(new URL(
      '../../../products/medical-integration/data/',
      import.meta.url,
    ));
  } catch {
    return path.resolve(
      process.cwd(),
      path.basename(process.cwd()).toLowerCase() === 'ui' ? '..' : '.',
      'products',
      'medical-integration',
      'data',
    );
  }
}
