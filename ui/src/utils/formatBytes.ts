const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;

/**
 * Human-readable byte size; returns '-' for missing or invalid input.
 * Goes up to TB because the admin overview sums whole user homes (design §9.2.1).
 */
export function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
  if (bytes < TB) return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
  return `${(bytes / TB).toFixed(1)} TB`;
}
