import type { TraumaPreferenceMemory } from "../../context/memory/MemoryDomainFacade.js";
import type { ValidatedTraumaPreference } from "./TraumaPreferencePolicy.js";

export type EffectivePresentationPolicy = {
  currentTurn: string[];
  projectFeedback: string[];
  globalPreferences: string[];
};

export const TRAUMA_PRESENTATION_PRIORITY_RULE =
  "表达偏好优先级：当前轮明确偏好 > 当前项目 Feedback > 全局用户画像 > 默认展示方式。";

export const TRAUMA_PRESENTATION_SAFETY_BOUNDARY =
  "偏好只能改变表达，不得改变医学事实、证据、阶段边界、结构化字段或安全要求。";

export function buildEffectivePresentationPolicy(input: {
  currentTurn: readonly ValidatedTraumaPreference[];
  recalled: TraumaPreferenceMemory | null;
}): EffectivePresentationPolicy {
  return {
    currentTurn: uniqueNonEmpty(input.currentTurn.map((item) => item.directive)),
    projectFeedback: asSingleSource(input.recalled?.projectFeedback),
    globalPreferences: asSingleSource(input.recalled?.globalProfile),
  };
}

export function renderEffectivePresentationPolicy(
  policy: EffectivePresentationPolicy,
): string | null {
  if (
    policy.currentTurn.length === 0
    && policy.projectFeedback.length === 0
    && policy.globalPreferences.length === 0
  ) {
    return null;
  }

  const sections: string[] = [];
  appendSection(sections, "当前轮偏好", policy.currentTurn);
  appendSection(sections, "当前项目 Feedback", policy.projectFeedback);
  appendSection(sections, "全局用户画像", policy.globalPreferences);
  return sections.join("\n\n");
}

function asSingleSource(value: string | undefined): string[] {
  const trimmed = value?.trim();
  return trimmed ? [trimmed] : [];
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function appendSection(target: string[], heading: string, values: readonly string[]): void {
  if (values.length === 0) return;
  target.push(`## ${heading}\n${values.map((value) => `- ${value}`).join("\n")}`);
}
