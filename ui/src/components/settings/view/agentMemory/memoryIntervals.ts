export type IntervalUnit = "minutes" | "hours";
export type MaintenanceMode = "immediate" | "interval" | "manual";

export const DEFAULT_INDEX_MINUTES = 30;
export const DEFAULT_DREAM_MINUTES = 60;
export const DEFAULT_MAINTENANCE_MODE: MaintenanceMode = "immediate";

type MemoryIntervals = {
  autoIndexIntervalMinutes?: number;
  autoDreamIntervalMinutes?: number;
  maintenanceMode?: MaintenanceMode;
};

export function toDisplayUnit(
  minutesValue: number | undefined,
  fallbackMinutes: number,
): { value: number; unit: IntervalUnit } {
  const resolved = minutesValue ?? fallbackMinutes;
  if (resolved > 0 && resolved % 60 === 0) {
    return { value: resolved / 60, unit: "hours" };
  }
  return { value: Math.max(0, resolved), unit: "minutes" };
}

export function toMinutes(
  value: number | undefined,
  unit: IntervalUnit,
): number {
  const safe =
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0;
  return unit === "hours" ? safe * 60 : safe;
}

export function resolveEnabledMemoryIntervals(
  input: (MemoryIntervals & { schedule?: MemoryIntervals }) | undefined,
): Required<MemoryIntervals> {
  const memory = { ...input?.schedule, ...input };
  return {
    autoIndexIntervalMinutes:
      memory?.autoIndexIntervalMinutes ?? DEFAULT_INDEX_MINUTES,
    autoDreamIntervalMinutes:
      memory?.autoDreamIntervalMinutes ?? DEFAULT_DREAM_MINUTES,
    maintenanceMode:
      memory?.maintenanceMode ?? (
        memory?.autoIndexIntervalMinutes !== undefined || memory?.autoDreamIntervalMinutes !== undefined
          ? "interval" : DEFAULT_MAINTENANCE_MODE
      ),
  };
}
