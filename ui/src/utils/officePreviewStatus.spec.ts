import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStorageUserRole } from './safeStorage';

const { statusMock, configMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  configMock: vi.fn(),
}));
vi.mock('./api', () => ({
  api: { officePreviewStatus: statusMock, pilotDeckConfig: configMock },
}));

import {
  readOfficePreviewStatus,
  normalizeOfficePreviewService,
  officePreviewRendererSignature,
  officePreviewRendererSignatureFromConfig,
} from './officePreviewStatus';

describe('normalizeOfficePreviewService', () => {
  it('defaults missing and unknown values to built-in preview', () => {
    expect(normalizeOfficePreviewService(undefined)).toBe('builtin');
    expect(normalizeOfficePreviewService('unexpected')).toBe('builtin');
  });

  it('keeps an explicit LibreOffice selection', () => {
    expect(normalizeOfficePreviewService(' LibreOffice ')).toBe('libreoffice');
  });
});

describe('Office preview renderer signatures', () => {
  it('tracks both the selected service and configured LibreOffice path', () => {
    expect(officePreviewRendererSignature('libreoffice', ' /opt/soffice ')).toBe(
      '["libreoffice","/opt/soffice"]',
    );
    expect(officePreviewRendererSignatureFromConfig({
      webui: { officePreview: { service: 'builtin', binaryPath: '' } },
    })).toBe('["builtin",""]');
  });

  it('ignores config payloads without an Office preview section', () => {
    expect(officePreviewRendererSignatureFromConfig({ model: {} })).toBeNull();
  });
});

describe('readOfficePreviewStatus config fallback', () => {
  beforeEach(() => {
    statusMock.mockReset();
    configMock.mockReset();
    statusMock.mockRejectedValue(new Error('status down'));
    configMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        config: { webui: { officePreview: { service: 'libreoffice', binaryPath: '/opt/soffice' } } },
      }),
    });
  });
  afterEach(() => setStorageUserRole(null));

  it('never requests /api/config for a normal user when the status call fails', async () => {
    setStorageUserRole('user');
    await expect(readOfficePreviewStatus()).rejects.toThrow('status down');
    expect(configMock).not.toHaveBeenCalled();
  });

  it('falls back to the config for an admin', async () => {
    setStorageUserRole('admin');
    await expect(readOfficePreviewStatus()).resolves.toMatchObject({
      service: 'libreoffice',
      configuredBinaryPath: '/opt/soffice',
      statusUnavailable: true,
    });
    expect(configMock).toHaveBeenCalledTimes(1);
  });
});
