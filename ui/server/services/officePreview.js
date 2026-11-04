import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { readPilotDeckConfigFile } from './pilotdeckConfig.js';

const officePreviewConversionLocks = new Map();

export const OFFICE_PREVIEW_SERVICE_BUILTIN = 'builtin';
export const OFFICE_PREVIEW_SERVICE_LIBREOFFICE = 'libreoffice';
const BUILTIN_OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const OFFICE_PREVIEW_CONVERSION_VERSION = 4;
const OFFICE_RENDERER_TIMEOUT_MS = Number(
  process.env.PILOTDECK_OFFICE_RENDERER_TIMEOUT_MS || 180000,
);

// Legacy formats need remote conversion. Modern formats use it when the
// operator selects print-layout preview.
export function isLibreOfficePreviewAllowed(extension, service) {
  return !BUILTIN_OFFICE_EXTENSIONS.has(extension)
    || service === OFFICE_PREVIEW_SERVICE_LIBREOFFICE;
}
// A shared, predictable /tmp directory may already belong to another OS
// account on a multi-user host. Keep each service account's conversions apart.
const cacheOwner = crypto.createHash('sha256')
  .update(String(process.getuid?.() ?? os.userInfo().username))
  .digest('hex')
  .slice(0, 16);
export const OFFICE_PREVIEW_CACHE_DIR = path.join(os.tmpdir(), `pilotdeck-office-preview-cache-${cacheOwner}`);
const OFFICE_PREVIEW_LOCK_STALE_MS = OFFICE_RENDERER_TIMEOUT_MS + 30000;
const OFFICE_PREVIEW_LOCK_RETRY_MS = 100;

export function getConfiguredOfficePreviewSettings() {
  try {
    const record = readPilotDeckConfigFile();
    const configured = String(record?.config?.webui?.officePreview?.service || '').trim().toLowerCase();
    return {
      service: configured === OFFICE_PREVIEW_SERVICE_LIBREOFFICE
        ? OFFICE_PREVIEW_SERVICE_LIBREOFFICE
        : OFFICE_PREVIEW_SERVICE_BUILTIN,
      binaryPath: String(record?.config?.webui?.officePreview?.binaryPath || '').trim(),
    };
  } catch (error) {
    console.warn('Failed to read Office preview config; defaulting to built-in:', error.message);
    return { service: OFFICE_PREVIEW_SERVICE_BUILTIN, binaryPath: '' };
  }
}

export function getConfiguredOfficePreviewService() {
  return getConfiguredOfficePreviewSettings().service;
}

export function getOfficeRendererSettings(environment = process.env) {
  return {
    url: String(environment.PILOTDECK_OFFICE_RENDERER_URL || '').trim().replace(/\/+$/, ''),
    token: String(environment.PILOTDECK_OFFICE_RENDERER_TOKEN || '').trim(),
  };
}

function createOfficePreviewError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findCachedPdf(cacheDir) {
  return (await fsPromises.readdir(cacheDir).catch(() => []))
    .find((name) => name.toLowerCase().endsWith('.pdf')) || null;
}

async function acquireDirectoryLock(lockDir) {
  while (true) {
    try {
      await fsPromises.mkdir(lockDir);
      return async () => {
        await fsPromises.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const stats = await fsPromises.stat(lockDir).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > OFFICE_PREVIEW_LOCK_STALE_MS) {
        await fsPromises.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }

      await sleep(OFFICE_PREVIEW_LOCK_RETRY_MS);
    }
  }
}

function resolvePathInsideRoot(rootPath, targetPath) {
  const normalizedRoot = path.resolve(rootPath);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(normalizedRoot, targetPath);

  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw createOfficePreviewError('Path must be under project root', 403, 'OFFICE_PREVIEW_PATH_FORBIDDEN');
  }

  return resolved;
}

async function probeOfficeRenderer(renderer) {
  if (!renderer.url) return { available: false, binaryPath: null, version: '' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${renderer.url}/health`, {
      signal: controller.signal,
      headers: renderer.token ? { Authorization: `Bearer ${renderer.token}` } : {},
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'ok') {
      return { available: false, binaryPath: null, version: '' };
    }
    return {
      available: true,
      binaryPath: null,
      version: body?.version || body?.service || 'Office Renderer',
      remote: true,
      capabilities: body?.capabilities || [],
    };
  } catch {
    return { available: false, binaryPath: null, version: '' };
  } finally {
    clearTimeout(timer);
  }
}

let libreOfficeStatusPromise = null;
let libreOfficeStatusCacheKey = '';
export async function getLibreOfficeStatus(options = {}) {
  const renderer = getOfficeRendererSettings();
  if (renderer.url) {
    const cacheKey = JSON.stringify({ renderer: renderer.url });
    if (options.forceRefresh || cacheKey !== libreOfficeStatusCacheKey) {
      libreOfficeStatusPromise = null;
      libreOfficeStatusCacheKey = cacheKey;
    }
    if (!libreOfficeStatusPromise) {
      libreOfficeStatusPromise = probeOfficeRenderer(renderer);
    }
    return libreOfficeStatusPromise;
  }

  return { available: false, binaryPath: null, version: '', reason: 'Office Renderer is not configured' };
}

export async function getLibreOfficeCandidateStatuses() {
  return [];
}

async function requestOfficeRenderer(renderer, endpoint, sourcePath, outputName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFFICE_RENDERER_TIMEOUT_MS);
  try {
    const sourceName = path.basename(sourcePath);
    const headerName = /^[\x20-\x7e]+$/.test(sourceName)
      ? sourceName
      : `input${path.extname(sourceName).toLowerCase() || '.bin'}`;
    const response = await fetch(`${renderer.url}${endpoint}`, {
      method: 'POST',
      body: await fsPromises.readFile(sourcePath),
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': headerName,
        ...(renderer.token ? { Authorization: `Bearer ${renderer.token}` } : {}),
      },
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      let detail = body.toString('utf8').trim();
      try {
        const parsed = JSON.parse(detail);
        detail = parsed.error || detail;
      } catch {
        // Keep the renderer's plain-text error.
      }
      const error = createOfficePreviewError(
        detail || `Office Renderer returned HTTP ${response.status}`,
        response.status >= 500 ? 502 : response.status,
        'OFFICE_RENDERER_FAILED',
      );
      throw error;
    }
    if (!body.length) {
      throw createOfficePreviewError(
        `Office Renderer returned an empty ${outputName}`,
        502,
        'OFFICE_RENDERER_OUTPUT_MISSING',
      );
    }
    return body;
  } catch (error) {
    if (error?.code === 'OFFICE_RENDERER_FAILED' || error?.code === 'OFFICE_RENDERER_OUTPUT_MISSING') {
      throw error;
    }
    throw createOfficePreviewError(
      `Office Renderer request failed: ${error instanceof Error ? error.message : String(error)}`,
      503,
      'OFFICE_RENDERER_UNAVAILABLE',
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function convertOfficeDocumentToPdf(sourcePath, options = {}) {
  const resolvedSourcePath = options.projectRoot
    ? resolvePathInsideRoot(options.projectRoot, sourcePath)
    : path.resolve(sourcePath);
  const stats = await fsPromises.stat(resolvedSourcePath);
  if (!stats.isFile()) {
    throw createOfficePreviewError('Office preview source is not a file', 404, 'OFFICE_PREVIEW_SOURCE_NOT_FOUND');
  }
  const renderer = getOfficeRendererSettings();
  if (!renderer.url) {
    throw createOfficePreviewError('Office Renderer is not configured', 503, 'OFFICE_RENDERER_UNAVAILABLE');
  }
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${OFFICE_PREVIEW_CONVERSION_VERSION}:${renderer.url}:${resolvedSourcePath}:${stats.size}:${stats.mtimeMs}`)
    .digest('hex');
  const cacheDir = path.join(OFFICE_PREVIEW_CACHE_DIR, cacheKey);

  const existingLock = officePreviewConversionLocks.get(cacheKey);
  const conversionPromise = (async () => {
    if (existingLock) {
      if (!options.force) {
        return existingLock;
      }
      await existingLock.catch(() => {});
    }

    return convertOfficeDocumentToPdfWithCache({
      cacheDir,
      force: options.force,
      resolvedSourcePath,
      renderer,
    });
  })();
  officePreviewConversionLocks.set(cacheKey, conversionPromise);

  try {
    return await conversionPromise;
  } finally {
    if (officePreviewConversionLocks.get(cacheKey) === conversionPromise) {
      officePreviewConversionLocks.delete(cacheKey);
    }
  }
}

async function convertOfficeDocumentToPdfWithCache({
  cacheDir,
  force,
  resolvedSourcePath,
  renderer,
}) {
  const lockDir = `${cacheDir}.lock`;
  let releaseLock = null;

  await fsPromises.mkdir(cacheDir, { recursive: true });

  if (!force) {
    const cachedPdf = await findCachedPdf(cacheDir);
    if (cachedPdf) {
      return resolvePathInsideRoot(cacheDir, cachedPdf);
    }
  }

  releaseLock = await acquireDirectoryLock(lockDir);

  try {
    if (force) {
      const entries = await fsPromises.readdir(cacheDir).catch(() => []);
      await Promise.all(entries.map((entry) => fsPromises.rm(path.join(cacheDir, entry), { recursive: true, force: true }).catch(() => {})));
    }

    const lockedCachedPdf = await findCachedPdf(cacheDir);
    if (lockedCachedPdf) {
      return resolvePathInsideRoot(cacheDir, lockedCachedPdf);
    }

    const pdf = await requestOfficeRenderer(
      renderer,
      '/v1/convert/pdf',
      resolvedSourcePath,
      'PDF',
    );
    const outputPdf = path.join(cacheDir, `${path.basename(resolvedSourcePath, path.extname(resolvedSourcePath))}.pdf`);
    const pendingPdfPath = `${outputPdf}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.writeFile(pendingPdfPath, pdf);
    await fsPromises.rename(pendingPdfPath, outputPdf);
    return resolvePathInsideRoot(cacheDir, path.basename(outputPdf));
  } finally {
    if (releaseLock) {
      await releaseLock();
    }

    const entries = await fsPromises.readdir(cacheDir).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.startsWith('convert-') || entry.endsWith('.tmp'))
      .map((entry) => fsPromises.rm(path.join(cacheDir, entry), { recursive: true, force: true }).catch(() => {})));
  }
}

export async function convertOfficeDocumentToXlsx(sourcePath, outputPath, options = {}) {
  const resolvedSourcePath = options.projectRoot
    ? resolvePathInsideRoot(options.projectRoot, sourcePath)
    : path.resolve(sourcePath);
  const stats = await fsPromises.stat(resolvedSourcePath).catch(() => null);
  if (!stats?.isFile()) {
    throw createOfficePreviewError(
      'Office conversion source is not a file',
      404,
      'OFFICE_PREVIEW_SOURCE_NOT_FOUND',
    );
  }
  const renderer = getOfficeRendererSettings();
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  if (renderer.url) {
    const workbook = await requestOfficeRenderer(
      renderer,
      '/v1/convert/xlsx',
      resolvedSourcePath,
      'XLSX workbook',
    );
    const pendingPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.writeFile(pendingPath, workbook);
    await fsPromises.rename(pendingPath, outputPath);
    return outputPath;
  }

  throw createOfficePreviewError('Office Renderer is not configured', 503, 'OFFICE_RENDERER_UNAVAILABLE');
}
