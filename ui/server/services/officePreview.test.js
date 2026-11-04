import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  convertOfficeDocumentToPdf,
  getLibreOfficeCandidateStatuses,
  getLibreOfficeStatus,
  getOfficeRendererSettings,
  isLibreOfficePreviewAllowed,
  OFFICE_PREVIEW_CACHE_DIR,
} from './officePreview.js';

describe('Office preview cache location', () => {
  it('uses an OS-account-specific path instead of the shared legacy cache', () => {
    expect(path.dirname(OFFICE_PREVIEW_CACHE_DIR)).toBe(path.resolve(tmpdir()));
    expect(path.basename(OFFICE_PREVIEW_CACHE_DIR)).toMatch(/^pilotdeck-office-preview-cache-[a-f0-9]{16}$/);
    expect(OFFICE_PREVIEW_CACHE_DIR).not.toBe(path.join(tmpdir(), 'pilotdeck-office-preview-cache'));
  });
});

describe('LibreOffice preview routing', () => {
  it('allows legacy files in either mode but requires an explicit selection for modern files', () => {
    for (const extension of ['doc', 'xls', 'ppt', 'wps', 'et', 'dps', 'odt', 'ods', 'odp']) {
      expect(isLibreOfficePreviewAllowed(extension, 'builtin')).toBe(true);
    }
    for (const extension of ['docx', 'xlsx', 'pptx']) {
      expect(isLibreOfficePreviewAllowed(extension, 'builtin')).toBe(false);
      expect(isLibreOfficePreviewAllowed(extension, 'libreoffice')).toBe(true);
    }
  });
});

describe('remote Office preview', () => {
  it('does not scan a local Office installation when the Renderer is absent', async () => {
    const previous = process.env.PILOTDECK_OFFICE_RENDERER_URL;
    delete process.env.PILOTDECK_OFFICE_RENDERER_URL;
    try {
      expect(getOfficeRendererSettings().url).toBe('');
      expect(await getLibreOfficeCandidateStatuses()).toEqual([]);
      expect((await getLibreOfficeStatus({ forceRefresh: true })).available).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PILOTDECK_OFFICE_RENDERER_URL;
      else process.env.PILOTDECK_OFFICE_RENDERER_URL = previous;
    }
  });

  it('returns an unavailable error without creating a local conversion', async () => {
    const testRoot = await mkdtemp(path.join(tmpdir(), 'pilotdeck-office-preview-test-'));
    const input = path.join(testRoot, 'source.pptx');
    const previous = process.env.PILOTDECK_OFFICE_RENDERER_URL;
    try {
      await writeFile(input, 'fake-source');
      delete process.env.PILOTDECK_OFFICE_RENDERER_URL;
      await expect(convertOfficeDocumentToPdf(input)).rejects.toMatchObject({
        code: 'OFFICE_RENDERER_UNAVAILABLE',
        statusCode: 503,
      });
      expect(await readFile(input, 'utf8')).toBe('fake-source');
    } finally {
      if (previous === undefined) delete process.env.PILOTDECK_OFFICE_RENDERER_URL;
      else process.env.PILOTDECK_OFFICE_RENDERER_URL = previous;
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
