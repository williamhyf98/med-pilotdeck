import { describe, expect, it } from 'vitest';
import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
  it('formats common sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(20 * 1024 ** 3)).toBe('20 GB');
    expect(formatBytes(1.5 * 1024 ** 4)).toBe('1.5 TB');
  });
  it('returns a dash for missing or invalid values', () => {
    expect(formatBytes(undefined)).toBe('-');
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
  });
});
