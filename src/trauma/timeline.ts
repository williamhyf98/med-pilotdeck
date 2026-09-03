import type { SubStage, TimelineState } from "./types.js";

const WINDOW_MINUTES: Partial<Record<SubStage, number>> = {
  primary_first_aid: 10,
  advanced_first_aid: 60,
  emergency_treatment: 180,
  surgical_resuscitation: 180,
  field_specialist_treatment: 360,
  definitive_specialist_treatment: 360,
};

export type ComputeTimelineInput = {
  injuryTime: string;
  now: string;
  currentSubStage: SubStage;
};

export function computeTimeline(input: ComputeTimelineInput): TimelineState {
  const recommendedWindowMinutes = WINDOW_MINUTES[input.currentSubStage];
  const injuryTime = Date.parse(input.injuryTime);
  const currentTime = Date.parse(input.now);
  const elapsedMinutes = Number.isFinite(injuryTime) && Number.isFinite(currentTime)
    ? Math.max(0, Math.floor((currentTime - injuryTime) / 60_000))
    : 0;

  let timingStatus: TimelineState["timingStatus"] = "within_window";
  if (recommendedWindowMinutes !== undefined) {
    if (elapsedMinutes > recommendedWindowMinutes) {
      timingStatus = "exceeded";
    } else if (elapsedMinutes >= recommendedWindowMinutes * 0.8) {
      timingStatus = "approaching";
    }
  }

  return {
    injuryTime: input.injuryTime,
    currentTime: input.now,
    elapsedMinutes,
    recommendedWindowMinutes,
    timingStatus,
    isHardGate: false,
  };
}
