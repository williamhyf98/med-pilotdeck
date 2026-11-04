import fs from 'node:fs/promises';
import path from 'node:path';

export function officeRendererUrl() {
  return String(process.env.PILOTDECK_OFFICE_RENDERER_URL || '').trim().replace(/\/+$/, '');
}

export async function requestOfficeRenderer(inputPath, endpoint, options = {}) {
  const url = officeRendererUrl();
  if (!url) throw new Error('Office Renderer is not configured (PILOTDECK_OFFICE_RENDERER_URL)');
  const source = path.resolve(inputPath);
  const name = path.basename(source);
  const extension = path.extname(name).toLowerCase();
  const safeName = /^[\x20-\x7e]+$/.test(name) ? name : `input${extension}`;
  const timeout = Number(process.env.PILOTDECK_OFFICE_RENDERER_TIMEOUT_MS) || 180000;
  let response;
  try {
    response = await fetch(`${url}${endpoint}`, {
      method: 'POST',
      body: await fs.readFile(source),
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': safeName,
        ...(process.env.PILOTDECK_OFFICE_RENDERER_TOKEN
          ? { Authorization: `Bearer ${process.env.PILOTDECK_OFFICE_RENDERER_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(`Office Renderer is unavailable: ${error.message}`, { cause: error });
  }
  if (!response.ok) {
    const body = await response.text();
    let detail = body.slice(0, 500);
    try { detail = JSON.parse(body).error || detail; } catch { /* Plain-text response. */ }
    throw new Error(`Office Renderer returned HTTP ${response.status}: ${detail}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new Error('Office Renderer returned an empty response');
  if (options.magic && !data.subarray(0, options.magic.length).equals(options.magic)) {
    throw new Error('Office Renderer returned an invalid file');
  }
  return data;
}
