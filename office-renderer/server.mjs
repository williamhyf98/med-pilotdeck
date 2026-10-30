#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(process.env.PILOTDECK_ROOT || path.join(MODULE_ROOT, '..'));
const RENDERER_HOST = process.env.PILOTDECK_OFFICE_RENDERER_HOST || '0.0.0.0';
const RENDERER_PORT = Number.parseInt(process.env.PILOTDECK_OFFICE_RENDERER_PORT || '19400', 10);
const MAX_INPUT_BYTES = Number.parseInt(
  process.env.PILOTDECK_OFFICE_RENDERER_MAX_BYTES || String(50 * 1024 * 1024),
  10,
);
const JOB_TIMEOUT_MS = Number.parseInt(
  process.env.PILOTDECK_OFFICE_RENDERER_TIMEOUT_MS || '180000',
  10,
);
const MAX_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.PILOTDECK_OFFICE_RENDERER_CONCURRENCY || '1', 10),
);
const RENDERER_TOKEN = String(process.env.PILOTDECK_OFFICE_RENDERER_TOKEN || '').trim();
const JOB_ROOT = path.join(PROJECT_ROOT, '.runtime', 'office-renderer', 'jobs');
const WORKER_PATH = path.join(MODULE_ROOT, 'worker.py');
const PYTHON_PATH = findPythonPath();
const BWRAP_PATH = process.env.PILOTDECK_OFFICE_RENDERER_BWRAP || 'bwrap';

let activeJobs = 0;
const pendingJobs = [];

function findPythonPath() {
  const configured = String(process.env.PILOTDECK_OFFICE_RENDERER_PYTHON || '').trim();
  const candidates = [
    configured,
    path.join(
      process.env.XDG_CACHE_HOME || path.join(PROJECT_ROOT, '.runtime', 'cache', 'xdg'),
      'pilotdeck-docx',
      'venv',
      'bin',
      'python',
    ),
    path.join(PROJECT_ROOT, '.runtime', 'cache', 'xdg', 'pilotdeck-docx', 'venv', 'bin', 'python'),
    path.join(PROJECT_ROOT, '.runtime', 'python', 'bin', 'python3'),
    'python3',
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === 'python3' || existsSync(candidate)) || 'python3';
}

function json(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.end(body);
}

function rendererError(message, statusCode = 500, code = 'office-renderer-failed') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function authorized(req) {
  if (!RENDERER_TOKEN) return true;
  const authorization = String(req.headers.authorization || '');
  return authorization === `Bearer ${RENDERER_TOKEN}`;
}

function safeFileName(value, fallback) {
  const name = path.basename(String(value || '').replaceAll('\\', '/'));
  return /^[A-Za-z0-9._-]{1,160}$/.test(name) ? name : fallback;
}

async function readRequestBody(req) {
  const declaredLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INPUT_BYTES) {
    throw rendererError('Office input is too large', 413, 'office-input-too-large');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      throw rendererError('Office input is too large', 413, 'office-input-too-large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function existingPaths(paths) {
  return paths.filter((value) => existsSync(value));
}

function workerBwrapArgs(jobDir, mode, inputName, target, dpi, emitPdf, includeText) {
  const outputDir = path.join(jobDir, 'output');
  const systemBinds = existingPaths([
    '/usr',
    '/lib',
    '/lib64',
    '/bin',
    '/sbin',
    '/etc/alternatives',
    '/etc/ssl',
    '/etc/resolv.conf',
    '/etc/libreoffice',
    '/etc/fonts',
  ]);
  const args = [
    '--clearenv',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];
  for (const bind of systemBinds) args.push('--ro-bind', bind, bind);
  args.push(
    '--ro-bind', PROJECT_ROOT, PROJECT_ROOT,
    '--bind', jobDir, jobDir,
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    '--chdir', jobDir,
    '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--setenv', 'HOME', path.join(jobDir, 'home'),
    '--setenv', 'TMPDIR', path.join(jobDir, 'tmp'),
    '--setenv', 'XDG_CACHE_HOME', path.join(jobDir, 'cache'),
    '--setenv', 'LANG', process.env.LANG || 'C.UTF-8',
    '--setenv', 'PYTHONPATH', path.join(PROJECT_ROOT, 'skills', 'docx', 'scripts'),
    '--setenv', 'DOCX_SKILL_SOFFICE', '/usr/bin/soffice',
    '--setenv', 'DOCX_SKILL_FONT_DIR', path.join(PROJECT_ROOT, 'skills', 'pdf', 'assets', 'fonts'),
    '/bin/sh',
    '-c',
    'exec "$@"',
    'pilotdeck-office-worker',
    PYTHON_PATH,
    WORKER_PATH,
    '--mode', mode,
    '--input', path.join(jobDir, inputName),
    '--output-dir', outputDir,
  );
  if (target) args.push('--target', target);
  if (dpi) args.push('--dpi', String(dpi));
  if (emitPdf) args.push('--emit-pdf');
  if (includeText) args.push('--include-text');
  return args;
}

function runWorker(jobDir, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(BWRAP_PATH, workerBwrapArgs(jobDir, options.mode, options.inputName, options.target, options.dpi, options.emitPdf, options.includeText), {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      reject(rendererError('Office rendering timed out', 504, 'office-renderer-timeout'));
    }, JOB_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(rendererError(`Office worker could not start: ${error.message}`, 503, 'office-worker-start-failed'));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let result = null;
      try {
        result = lines.length ? JSON.parse(lines.at(-1)) : null;
      } catch {
        result = null;
      }
      if (code !== 0 || !result || result.status !== 'ok') {
        const detail = result?.error || stderr.trim() || `worker exited with ${signal || code}`;
        reject(rendererError(detail.slice(0, 2000), 502, result?.code || 'office-worker-failed'));
        return;
      }
      resolve(result);
    });
  });
}

async function withJob(options, callback) {
  await fs.mkdir(JOB_ROOT, { recursive: true });
  const jobDir = await fs.mkdtemp(path.join(JOB_ROOT, 'job-'));
  await Promise.all([
    fs.mkdir(path.join(jobDir, 'home'), { recursive: true }),
    fs.mkdir(path.join(jobDir, 'tmp'), { recursive: true }),
    fs.mkdir(path.join(jobDir, 'cache'), { recursive: true }),
    fs.mkdir(path.join(jobDir, 'output'), { recursive: true }),
  ]);
  const inputPath = path.join(jobDir, options.inputName);
  try {
    await fs.writeFile(inputPath, options.body, { mode: 0o600 });
    return await callback(jobDir);
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function enqueue(callback) {
  if (activeJobs >= MAX_CONCURRENCY) {
    await new Promise((resolve) => pendingJobs.push(resolve));
  }
  activeJobs += 1;
  try {
    return await callback();
  } finally {
    activeJobs -= 1;
    pendingJobs.shift()?.();
  }
}

async function makeRenderArchive(jobDir, result) {
  if (!result?.archive) {
    throw rendererError('Office worker did not produce a render archive', 502, 'office-renderer-output-missing');
  }
  return fs.readFile(result.archive);
}

async function handleRenderDocx(req, res) {
  if (!authorized(req)) return json(res, 401, { error: 'Unauthorized', code: 'office-renderer-unauthorized' });
  const body = await readRequestBody(req);
  const dpi = Math.max(72, Math.min(300, Number.parseInt(String(new URL(req.url, 'http://renderer').searchParams.get('dpi') || '144'), 10) || 144));
  const emitPdf = new URL(req.url, 'http://renderer').searchParams.get('emit_pdf') === '1';
  const includeText = new URL(req.url, 'http://renderer').searchParams.get('include_text') === '1';
  const inputName = safeFileName(req.headers['x-file-name'], 'input.docx').replace(/\.[^.]+$/, '.docx');
  const archive = await enqueue(() => withJob(
    { body, inputName },
    async (jobDir) => {
      const result = await runWorker(jobDir, {
        mode: 'render-docx',
        inputName,
        dpi,
        emitPdf,
        includeText,
      });
      return makeRenderArchive(jobDir, result);
    },
  ));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', archive.length);
  res.end(archive);
}

async function handleConvert(req, res, target) {
  if (!authorized(req)) return json(res, 401, { error: 'Unauthorized', code: 'office-renderer-unauthorized' });
  const body = await readRequestBody(req);
  const inputName = safeFileName(req.headers['x-file-name'], `input.${target === 'xlsx' ? 'xls' : 'docx'}`);
  const output = await enqueue(() => withJob(
    { body, inputName },
    async (jobDir) => {
      const result = await runWorker(jobDir, {
        mode: 'convert',
        inputName,
        target,
      });
      return fs.readFile(path.join(jobDir, 'output', `result.${target}`));
    },
  ));
  res.statusCode = 200;
  res.setHeader('Content-Type', target === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', output.length);
  res.end(output);
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${RENDERER_HOST}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        status: 'ok',
        service: 'office-renderer',
        port: RENDERER_PORT,
        worker: existsSync(WORKER_PATH),
        bwrap: BWRAP_PATH,
        capabilities: ['docx-render', 'office-to-pdf', 'office-to-xlsx'],
      });
    }
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'Method not allowed', code: 'office-renderer-method-not-allowed' });
    }
    if (url.pathname === '/v1/render/docx') return await handleRenderDocx(req, res);
    if (url.pathname === '/v1/convert/pdf') return await handleConvert(req, res, 'pdf');
    if (url.pathname === '/v1/convert/xlsx') return await handleConvert(req, res, 'xlsx');
    return json(res, 404, { error: 'Not found', code: 'office-renderer-not-found' });
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    console.error('[office-renderer]', error?.stack || error);
    if (!res.headersSent) {
      json(res, statusCode, {
        error: error?.message || 'Office Renderer failed',
        code: error?.code || 'office-renderer-failed',
      });
    } else {
      res.destroy();
    }
  }
}

const server = http.createServer(requestHandler);
server.listen(RENDERER_PORT, RENDERER_HOST, () => {
  console.log(`[office-renderer] listening on http://${RENDERER_HOST}:${RENDERER_PORT}`);
  console.log(`[office-renderer] project root: ${PROJECT_ROOT}`);
  console.log(`[office-renderer] python: ${PYTHON_PATH}`);
  console.log(`[office-renderer] bwrap: ${BWRAP_PATH}`);
});

function shutdown(signal) {
  console.log(`[office-renderer] stopping on ${signal}`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
