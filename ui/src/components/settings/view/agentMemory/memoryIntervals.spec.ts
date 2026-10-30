import { describe, expect, it } from "vitest";
import {
  DEFAULT_DREAM_MINUTES,
  DEFAULT_INDEX_MINUTES,
  resolveEnabledMemoryIntervals,
  toDisplayUnit,
  toMinutes,
} from "./memoryIntervals";

describe("memory interval helpers", () => {
  it("displays legacy nested settings but gives flat UI edits priority", () => {
    expect(resolveEnabledMemoryIntervals({ schedule: { maintenanceMode: "manual", autoDreamIntervalMinutes: 120 } }))
      .toEqual({ maintenanceMode: "manual", autoIndexIntervalMinutes: 30, autoDreamIntervalMinutes: 120 });
    expect(resolveEnabledMemoryIntervals({ maintenanceMode: "immediate", schedule: { maintenanceMode: "manual" } }).maintenanceMode)
      .toBe("immediate");
  });
  it("defaults new settings to immediate but preserves explicit modes", () => {
    expect(resolveEnabledMemoryIntervals(undefined).maintenanceMode).toBe("immediate");
    expect(resolveEnabledMemoryIntervals({ maintenanceMode: "manual" }).maintenanceMode).toBe("manual");
    expect(resolveEnabledMemoryIntervals({ maintenanceMode: "immediate", autoIndexIntervalMinutes: 0 }).maintenanceMode).toBe("immediate");
  });
  it("preserves zero as the disabled interval", () => {
    expect(toDisplayUnit(0, DEFAULT_INDEX_MINUTES)).toEqual({
      value: 0,
      unit: "minutes",
    });
    expect(toMinutes(0, "minutes")).toBe(0);
    expect(toMinutes(0, "hours")).toBe(0);
  });

  it("does not replace explicit zero values when memory is enabled", () => {
    expect(
      resolveEnabledMemoryIntervals({
        autoIndexIntervalMinutes: 0,
        autoDreamIntervalMinutes: 0,
      }),
    ).toEqual({
      autoIndexIntervalMinutes: 0,
      autoDreamIntervalMinutes: 0,
      maintenanceMode: "interval",
    });
  });

  it("fills defaults only for missing interval values", () => {
    expect(
      resolveEnabledMemoryIntervals({
        autoIndexIntervalMinutes: 15,
      }),
    ).toEqual({
      autoIndexIntervalMinutes: 15,
      autoDreamIntervalMinutes: DEFAULT_DREAM_MINUTES,
      maintenanceMode: "interval",
    });
  });
});
