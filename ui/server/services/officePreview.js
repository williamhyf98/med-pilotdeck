import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import { readPilotDeckConfigFile } from './pilotdeckConfig.js';

const execFileAsync = promisify(execFile);

const officePreviewConversionLocks = new Map();

export const OFFICE_PREVIEW_SERVICE_BUILTIN = 'builtin';
export const OFFICE_PREVIEW_SERVICE_LIBREOFFICE = 'libreoffice';
const BUILTIN_OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const MAC_FONTCONFIG_FILES = [
  '/opt/homebrew/etc/fonts/fonts.conf',
  '/usr/local/etc/fonts/fonts.conf',
];
const OFFICE_PREVIEW_CONVERSION_VERSION = 3;
const OFFICE_RENDERER_TIMEOUT_MS = Number(
  process.env.PILOTDECK_OFFICE_RENDERER_TIMEOUT_MS || 180000,
);

export function getLibreOfficeConversionEnvironment({
  platform = process.platform,
  environment = process.env,
  exists = fs.existsSync,
} = {}) {
  if (platform !== 'darwin' || environment.FONTCONFIG_FILE) return { ...environment };
  const fontConfig = MAC_FONTCONFIG_FILES.find((candidate) => exists(candidate));
  return fontConfig ? { ...environment, FONTCONFIG_FILE: fontConfig } : { ...environment };
}

// Legacy formats always need LibreOffice. Modern formats use it only when the
// operator explicitly selects the print-layout renderer.
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
export const LIBREOFFICE_TIMEOUT_MS = Number(process.env.PILOTDECK_LIBREOFFICE_TIMEOUT_MS || 120000);
const OFFICE_PREVIEW_LOCK_STALE_MS = LIBREOFFICE_TIMEOUT_MS + 30000;
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

function getConfiguredLibreOfficeBinaryPath() {
  return getConfiguredOfficePreviewSettings().binaryPath;
}

function uniqueCandidates(candidates) {
  return Array.from(new Set(candidates.map((candidate) => String(candidate || '').trim()).filter(Boolean)));
}

function getEnvironmentLibreOfficeCandidates() {
  return uniqueCandidates([
    process.env.LIBREOFFICE_PATH,
    process.env.SOFFICE_PATH,
  ]);
}

function readDirectoryNames(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function getMacLibreOfficeAppCandidates() {
  const appDirectories = [
    '/Applications',
    path.join(os.homedir(), 'Applications'),
  ];
  return appDirectories.flatMap((directoryPath) =>
    readDirectoryNames(directoryPath)
      .filter((name) => /^LibreOffice.*\.app$/i.test(name))
      .map((name) => path.join(directoryPath, name, 'Contents/MacOS/soffice')));
}

function getLinuxOptLibreOfficeCandidates() {
  return readDirectoryNames('/opt')
    .filter((name) => /^libreoffice/i.test(name))
    .map((name) => path.join('/opt', name, 'program/soffice'));
}

export function getWindowsLibreOfficeCandidates(environment = process.env) {
  const programDirectories = uniqueCandidates([
    environment.ProgramW6432,
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ]);

  // soffice.exe is a GUI-subsystem launcher. Running it with --version from
  // Node can remain alive until the probe times out, while soffice.com is the
  // console launcher intended for command-line use on Windows.
  return programDirectories.map((directoryPath) =>
    path.win32.join(directoryPath, 'LibreOffice', 'program', 'soffice.com'));
}

function getPlatformLibreOfficeCandidates() {
  const macCandidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    ...getMacLibreOfficeAppCandidates(),
  ];
  const linuxCandidates = [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/usr/local/bin/libreoffice',
    '/snap/bin/libreoffice',
    '/opt/libreoffice/program/soffice',
    ...getLinuxOptLibreOfficeCandidates(),
  ];
  const windowsCandidates = getWindowsLibreOfficeCandidates();

  return process.platform === 'darwin'
    ? macCandidates
    : process.platform === 'win32'
      ? windowsCandidates
      : linuxCandidates;
}

function getPathLibreOfficeCandidates() {
  const pathCandidates = [
    'soffice',
    'libreoffice',
  ];
  return pathCandidates;
}

function getAutoLibreOfficeCandidates() {
  return uniqueCandidates([
    ...getEnvironmentLibreOfficeCandidates(),
    ...getPlatformLibreOfficeCandidates(),
    ...getPathLibreOfficeCandidates(),
  ]);
}

function getScannableLibreOfficeCandidates() {
  return uniqueCandidates([
    getConfiguredLibreOfficeBinaryPath(),
    ...getEnvironmentLibreOfficeCandidates(),
    ...getPlatformLibreOfficeCandidates(),
  ]);
}

function getLibreOfficeCandidates() {
  const configured = getConfiguredLibreOfficeBinaryPath();
  return configured ? [configured] : getAutoLibreOfficeCandidates();
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

export async function createLibreOfficeConversionWorkspace(cacheDir) {
  const tempDir = await fsPromises.mkdtemp(path.join(cacheDir, 'convert-'));
  try {
    // Keep the LibreOffice profile close to the system temp root. On Windows,
    // nesting it under the hashed cache/output directory makes LibreOffice's
    // internal profile paths exceed the legacy MAX_PATH limit. In that case
    // soffice exits successfully but silently produces no PDF.
    const profileDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-lo-profile-'));
    return { tempDir, profileDir };
  } catch (error) {
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
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

async function publishConvertedPdf(tempDir, cacheDir) {
  const outputPdf = await findCachedPdf(tempDir);
  if (!outputPdf) {
    throw createOfficePreviewError('LibreOffice did not produce a PDF preview', 500, 'LIBREOFFICE_OUTPUT_MISSING');
  }

  const sourcePdfPath = resolvePathInsideRoot(tempDir, outputPdf);
  const publishedPdfPath = path.join(cacheDir, outputPdf);
  const pendingPdfPath = `${publishedPdfPath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.copyFile(sourcePdfPath, pendingPdfPath);
  await fsPromises.rename(pendingPdfPath, publishedPdfPath);
  return resolvePathInsideRoot(cacheDir, outputPdf);
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

async function probeLibreOfficeCandidate(candidate) {
  try {
    const result = await execFileAsync(candidate, ['--version'], {
      timeout: 5000,
      windowsHide: true,
    });
    return {
      binaryPath: candidate,
      available: true,
      version: String(result.stdout || result.stderr || '').trim(),
    };
  } catch (error) {
    return {
      binaryPath: candidate,
      available: false,
      version: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
let libreOfficeCandidateStatusesPromise = null;
let libreOfficeCandidateStatusesCacheKey = '';

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

  const candidates = getLibreOfficeCandidates();
  const cacheKey = JSON.stringify(candidates);

  if (options.forceRefresh || cacheKey !== libreOfficeStatusCacheKey) {
    libreOfficeStatusPromise = null;
    libreOfficeStatusCacheKey = cacheKey;
  }

  if (!libreOfficeStatusPromise) {
    libreOfficeStatusPromise = (async () => {
      for (const candidate of candidates) {
        const result = await probeLibreOfficeCandidate(candidate);
        if (result.available) {
          return {
            available: true,
            binaryPath: result.binaryPath,
            version: result.version,
          };
        }
      }
      return {
        available: false,
        binaryPath: null,
        version: '',
      };
    })();
  }
  return libreOfficeStatusPromise;
}

export async function getLibreOfficeCandidateStatuses(options = {}) {
  if (getOfficeRendererSettings().url) return [];
  const candidates = getScannableLibreOfficeCandidates();
  const cacheKey = JSON.stringify(candidates);

  if (options.forceRefresh || cacheKey !== libreOfficeCandidateStatusesCacheKey) {
    libreOfficeCandidateStatusesPromise = null;
    libreOfficeCandidateStatusesCacheKey = cacheKey;
  }

  if (!libreOfficeCandidateStatusesPromise) {
    libreOfficeCandidateStatusesPromise = Promise.all(
      candidates.map((candidate) => probeLibreOfficeCandidate(candidate)),
    );
  }

  return libreOfficeCandidateStatusesPromise;
}

async function getLibreOfficeBinary() {
  const status = await getLibreOfficeStatus();
  return status.available ? status.binaryPath : null;
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
  const binary = renderer.url ? null : await getLibreOfficeBinary();
  if (!renderer.url && !binary) {
    throw createOfficePreviewError('LibreOffice executable not found', 501, 'LIBREOFFICE_NOT_FOUND');
  }
  const conversionEnvironment = getLibreOfficeConversionEnvironment();
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${OFFICE_PREVIEW_CONVERSION_VERSION}:${renderer.url || ''}:${conversionEnvironment.FONTCONFIG_FILE || ''}:${resolvedSourcePath}:${stats.size}:${stats.mtimeMs}`)
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
      binary,
      cacheDir,
      force: options.force,
      resolvedSourcePath,
      conversionEnvironment,
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
  binary,
  cacheDir,
  force,
  resolvedSourcePath,
  conversionEnvironment,
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

    if (renderer.url) {
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
    }

    const { tempDir, profileDir } = await createLibreOfficeConversionWorkspace(cacheDir);
    const args = [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      tempDir,
      resolvedSourcePath,
    ];

    try {
      let conversionOutput;
      try {
        conversionOutput = await execFileAsync(binary, args, {
          timeout: LIBREOFFICE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          env: conversionEnvironment,
        });
      } catch (error) {
        error.statusCode = 500;
        error.code = error.code || 'LIBREOFFICE_CONVERT_FAILED';
        throw error;
      }

      try {
        return await publishConvertedPdf(tempDir, cacheDir);
      } catch (error) {
        error.stdout = String(conversionOutput.stdout || '').trim();
        error.stderr = String(conversionOutput.stderr || '').trim();
        throw error;
      }
    } finally {
      await Promise.all([
        fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {}),
        fsPromises.rm(profileDir, { recursive: true, force: true }).catch(() => {}),
      ]);
    }
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

  const binary = await getLibreOfficeBinary();
  if (!binary) {
    throw createOfficePreviewError('LibreOffice executable not found', 501, 'LIBREOFFICE_NOT_FOUND');
  }
  const workspace = await createLibreOfficeConversionWorkspace(
    options.cacheDir || path.dirname(outputPath),
  );
  try {
    const conversionOutput = await execFileAsync(binary, [
      `-env:UserInstallation=${pathToFileURL(workspace.profileDir).href}`,
      '--headless',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      '--nofirststartwizard',
      '--convert-to',
      'xlsx:Calc MS Excel 2007 XML',
      '--outdir',
      workspace.tempDir,
      resolvedSourcePath,
    ], {
      timeout: LIBREOFFICE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: getLibreOfficeConversionEnvironment(),
    });
    const generatedName = (await fsPromises.readdir(workspace.tempDir))
      .find((name) => name.toLowerCase().endsWith('.xlsx'));
    if (!generatedName) {
      const detail = String(conversionOutput?.stderr || conversionOutput?.stdout || '').trim();
      throw createOfficePreviewError(
        `LibreOffice did not produce an XLSX workbook${detail ? `: ${detail}` : ''}`,
        500,
        'SPREADSHEET_XLSX_OUTPUT_MISSING',
      );
    }
    const pendingPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.copyFile(path.join(workspace.tempDir, generatedName), pendingPath);
    await fsPromises.rename(pendingPath, outputPath);
    return outputPath;
  } catch (error) {
    error.statusCode = error.statusCode || 500;
    error.code = error.code || 'SPREADSHEET_XLSX_CONVERT_FAILED';
    throw error;
  } finally {
    await Promise.all([
      fsPromises.rm(workspace.tempDir, { recursive: true, force: true }).catch(() => {}),
      fsPromises.rm(workspace.profileDir, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
}
