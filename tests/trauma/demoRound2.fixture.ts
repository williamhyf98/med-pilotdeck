import type { ExtractedTurnFacts } from "../../src/trauma/types.js";

export const DEMO_ROUND_2_USER_TEXT =
  "呼吸大约每分钟32次，胸口没有明显开放伤，但右侧胸部呼吸时疼得厉害。收缩压95，心率120。小腿压迫后基本止住血了。";

export const DEMO_ROUND_2_EXTRACTED: ExtractedTurnFacts = {
  turnKind: "case_update",
  context: {},
  vitalSigns: [
    {
      value: { type: "respiratory_rate", value: 32, unit: "/min" },
      sourceMessageId: "message-2",
      sourceQuote: "呼吸大约每分钟32次",
      certainty: "confirmed",
      confidence: 0.98,
    },
    {
      value: { type: "blood_pressure", value: { systolic: 95 }, unit: "mmHg" },
      sourceMessageId: "message-2",
      sourceQuote: "收缩压95",
      certainty: "confirmed",
      confidence: 0.98,
    },
    {
      value: { type: "heart_rate", value: 120, unit: "/min" },
      sourceMessageId: "message-2",
      sourceQuote: "心率120",
      certainty: "confirmed",
      confidence: 0.98,
    },
  ],
  injuryFindings: [
    {
      value: {
        bodyPart: "右侧胸部",
        finding: "呼吸时剧烈疼痛，无明显开放伤",
        status: "active",
      },
      sourceMessageId: "message-2",
      sourceQuote: "胸口没有明显开放伤，但右侧胸部呼吸时疼得厉害",
      certainty: "confirmed",
      confidence: 0.94,
    },
  ],
  treatmentEvents: [
    {
      value: {
        action: "右小腿压迫止血",
        status: "completed",
        effect: "effective",
      },
      sourceMessageId: "message-2",
      sourceQuote: "小腿压迫后基本止住血了",
      certainty: "confirmed",
      confidence: 0.97,
    },
  ],
  careAndTransportFacts: [],
  correctionsAndProvenance: { conflictingFactIds: [] },
};

export const DEMO_ROUND_2_REASONER_OUTPUT = {
  naturalLanguageAnswer:
    "右小腿出血目前已控制，但呼吸急促、胸痛和循环指标提示仍需高优先级处置。当前仍处于初级急救，建议在维持现有救命措施的同时，确认转入具备高级急救能力的下一子级。",
  classification: {
    version: 2,
    type: "emergency_triage",
    createdAt: "2026-09-03T15:09:00+08:00",
    severity: "severe",
    treatmentPriority: "urgent",
    transportPriority: "urgent",
    rationale: ["呼吸频率32次/分", "收缩压95mmHg", "心率120次/分"],
  },
  treatmentPlan: [
    {
      id: "r2-action-1",
      title: "持续基础生命支持",
      description: "保持气道通畅、继续观察呼吸和循环变化",
      scope: "current_stage",
      priority: 1,
      evidenceChunkIds: ["chunk-stage"],
      professionalConfirmationRequired: false,
    },
  ],
  missingInformation: ["SpO₂", "胸部听诊与气管位置"],
  transition: {
    status: "READY",
    targetStage: "battlefield_first_aid",
    targetSubStage: "advanced_first_aid",
    reason: "呼吸与循环风险需要高级急救能力",
    requiresUserConfirmation: true,
  },
  gateAssessment: {
    needHigherCapability: true,
    requiredCapabilities: ["高级气道与呼吸支持", "持续循环监护"],
    targetStage: "battlefield_first_aid",
    targetSubStage: "advanced_first_aid",
    transportReadiness: "ready",
    instabilityIndicators: ["呼吸急促", "心动过速"],
    blockingFactors: [],
    transportPrerequisites: ["继续维持止血效果"],
    ruleConflicts: [],
    confidence: 0.91,
    evidenceChunkIds: ["chunk-stage"],
  },
  memo: {
    round: 2,
    mainStage: "battlefield_first_aid",
    subStage: "primary_first_aid",
    title: "生命体征补充",
    inputPoints: ["RR32、SBP95、HR120", "右小腿压迫后出血基本控制"],
    actionPoints: ["维持气道、呼吸与循环观察", "准备转入高级急救"],
    conclusion: "当前仍属初级急救，Gate READY，等待确认转入高级急救",
  },
} as const;
