import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLibreOfficeConversionWorkspace,
  getLibreOfficeConversionEnvironment,
  getWindowsLibreOfficeCandidates,
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

describe('LibreOffice font configuration', () => {
  it('uses an installed Fontconfig file on macOS when none is configured', () => {
    const environment = { PATH: '/usr/bin' };
    const result = getLibreOfficeConversionEnvironment({
      platform: 'darwin',
      environment,
      exists: (file) => file === '/opt/homebrew/etc/fonts/fonts.conf',
    });
    expect(result).toEqual({ PATH: '/usr/bin', FONTCONFIG_FILE: '/opt/homebrew/etc/fonts/fonts.conf' });
    expect(environment).toEqual({ PATH: '/usr/bin' });
  });

  it('preserves explicit configuration and does not impose a Mac path on Linux', () => {
    const exists = () => true;
    expect(getLibreOfficeConversionEnvironment({
      platform: 'darwin', environment: { FONTCONFIG_FILE: '/custom/fonts.conf' }, exists,
    }).FONTCONFIG_FILE).toBe('/custom/fonts.conf');
    expect(getLibreOfficeConversionEnvironment({
      platform: 'linux', environment: { PATH: '/usr/bin' }, exists,
    })).toEqual({ PATH: '/usr/bin' });
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

describe('getWindowsLibreOfficeCandidates', () => {
  it('uses the console launcher and honors Windows Program Files locations', () => {
    const candidates = getWindowsLibreOfficeCandidates({
      ProgramW6432: 'D:\\Programs',
      ProgramFiles: 'D:\\Programs',
      'ProgramFiles(x86)': 'D:\\Programs (x86)',
    });

    expect(candidates).toEqual([
      'D:\\Programs\\LibreOffice\\program\\soffice.com',
      'D:\\Programs (x86)\\LibreOffice\\program\\soffice.com',
      'C:\\Program Files\\LibreOffice\\program\\soffice.com',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
    ]);
    expect(candidates.every((candidate) => candidate.endsWith('soffice.com'))).toBe(true);
  });
});

describe('createLibreOfficeConversionWorkspace', () => {
  it('keeps the LibreOffice profile outside the hashed conversion directory', async () => {
    const testRoot = await mkdtemp(path.join(tmpdir(), 'pilotdeck-office-preview-test-'));
    const cacheDir = path.join(testRoot, 'a'.repeat(64));
    await mkdir(cacheDir);

    let workspace;
    try {
      workspace = await createLibreOfficeConversionWorkspace(cacheDir);

      expect(path.dirname(workspace.tempDir)).toBe(cacheDir);
      expect(path.dirname(workspace.profileDir)).toBe(path.resolve(tmpdir()));
      expect(workspace.profileDir.startsWith(workspace.tempDir)).toBe(false);
      expect(workspace.profileDir.length).toBeLessThan(workspace.tempDir.length);
    } finally {
      await Promise.all([
        workspace?.profileDir
          ? rm(workspace.profileDir, { recursive: true, force: true })
          : Promise.resolve(),
        rm(testRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
