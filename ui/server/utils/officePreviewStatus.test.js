// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { shapeOfficePreviewStatus } from './officePreviewStatus.js';

const full = {
  service: 'libreoffice',
  configuredBinaryPath: '/opt/homebrew/bin/soffice',
  libreOffice: {
    available: true,
    binaryPath: '/opt/homebrew/bin/soffice',
    version: '7.6',
    candidates: [{ binaryPath: '/opt/homebrew/bin/soffice', available: true }],
  },
  supportedServices: ['builtin', 'libreoffice'],
};

describe('shapeOfficePreviewStatus', () => {
  it('gives administrators the full payload untouched', () => {
    expect(shapeOfficePreviewStatus(full, 'admin')).toBe(full);
  });

  it('tells a normal user only whether LibreOffice is available', () => {
    expect(shapeOfficePreviewStatus(full, 'user')).toEqual({
      service: 'libreoffice',
      libreOffice: { available: true },
      supportedServices: ['builtin', 'libreoffice'],
    });
  });

  it('leaks no host path for a normal user, whatever the payload holds', () => {
    const trimmed = shapeOfficePreviewStatus(full, 'user');
    expect(JSON.stringify(trimmed)).not.toContain('soffice');
    expect(trimmed).not.toHaveProperty('configuredBinaryPath');
    expect(trimmed.libreOffice).not.toHaveProperty('candidates');
    expect(trimmed.libreOffice).not.toHaveProperty('binaryPath');
  });

  it('reports unavailable rather than undefined when detection found nothing', () => {
    expect(shapeOfficePreviewStatus({ service: 'builtin', supportedServices: [] }, 'user'))
      .toEqual({ service: 'builtin', libreOffice: { available: false }, supportedServices: [] });
  });
});
