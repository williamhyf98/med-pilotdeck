export function policyRecord(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new Error(`${path}.${key} is not a supported policy field.`);
  }
  return record;
}

export function policyList(value: unknown, path: string, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${path} must be an array of at most ${max} entries.`);
  return value;
}

export function policyIds(value: unknown, path: string): string[] {
  const items = policyList(value, path);
  if (items.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u.test(item))
    || new Set(items).size !== items.length) {
    throw new Error(`${path} must contain unique registered capability IDs.`);
  }
  return items as string[];
}

export function policyRoots<T extends string>(
  value: unknown, path: string, allowed: readonly T[],
): T[] {
  const items = policyList(value, path, 3);
  if (items.some((item) => typeof item !== "string" || !allowed.includes(item as T))
    || new Set(items).size !== items.length) {
    throw new Error(`${path} contains an invalid or repeated task directory.`);
  }
  return items as T[];
}
