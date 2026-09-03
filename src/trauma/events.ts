import type { GatewayEvent } from "../gateway/protocol/types.js";
import type { AgentTurnResponse } from "./types.js";

const SUBSTAGE_LABELS: Record<string, string> = {
  primary_first_aid: "初级急救",
  advanced_first_aid: "高级急救",
  emergency_treatment: "紧急救治",
  surgical_resuscitation: "紧急手术复苏",
  field_specialist_treatment: "野战专科治疗",
  definitive_specialist_treatment: "确定性专科治疗",
  functional_recovery: "功能恢复",
  psychophysical_rehabilitation: "身心康复",
};

/**
 * The READY question is intentionally non-blocking. It resembles an
 * ask_user_question card, but its answer is sent to trauma.confirmTransition
 * instead of Gateway.respondElicitation.
 */
export function traumaTurnEvents(input: {
  response: AgentTurnResponse;
  runId: string;
  version: number;
}): GatewayEvent[] {
  const events: GatewayEvent[] = [
    { type: "turn_started", runId: input.runId },
    {
      type: "assistant_text_delta",
      text: input.response.naturalLanguageAnswer,
      runId: input.runId,
    },
  ];

  if (
    input.response.transition.status === "READY"
    && input.response.transition.targetSubStage
  ) {
    const target = SUBSTAGE_LABELS[input.response.transition.targetSubStage]
      ?? input.response.transition.targetSubStage;
    const toolCallId = `trauma-transition:${input.runId}`;
    events.push({
      type: "elicitation_request",
      requestId: toolCallId,
      toolCallId,
      toolName: "ask_user_question",
      questions: [
        {
          header: "阶段转换",
          question: `是否确认将救治阶段转入「${target}」？`,
          options: [
            {
              label: "确认转换",
              description: "应用建议的目标救治阶段并继续推演",
            },
            {
              label: "暂不转换",
              description: "保留当前救治阶段，继续补充信息或处置",
            },
          ],
        },
      ],
      metadata: {
        source: "trauma_pending_transition",
        version: input.version,
      },
      runId: input.runId,
    });
  }

  events.push({
    type: "turn_completed",
    usage: {},
    finishReason: "completed",
    runId: input.runId,
  });
  return events;
}
