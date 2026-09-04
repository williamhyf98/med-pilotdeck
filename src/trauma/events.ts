import type { GatewayEvent } from "../gateway/protocol/types.js";
import type { TraumaTurnProgress } from "./runner.js";
import type { AgentTurnResponse } from "./types.js";

const PHASE_LABELS: Record<TraumaTurnProgress["phase"], string> = {
  extract: "抽取伤情事实",
  retrieve: "检索战伤救治规则",
  reason: "综合研判与分级",
};

/**
 * 把推演阶段映射成工具调用事件，让等待期间的界面有可见进度，
 * 而不是整轮结束前一直停在「连接中」。
 */
export function traumaProgressEvents(input: {
  progress: TraumaTurnProgress;
  runId: string;
}): GatewayEvent[] {
  const { progress, runId } = input;
  const toolCallId = `trauma-${progress.phase}:${runId}`;
  const name = PHASE_LABELS[progress.phase];
  if (progress.status === "started") {
    return [{
      type: "tool_call_started",
      toolCallId,
      name,
      argsPreview: progress.detail,
      runId,
    }];
  }
  return [{
    type: "tool_call_finished",
    toolCallId,
    toolName: name,
    ok: progress.ok,
    resultPreview: progress.detail,
    runId,
  }];
}

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
  /** 宿主已在推演开始时发过 turn_started 时置为 true，避免重复。 */
  turnStartedAlreadyEmitted?: boolean;
}): GatewayEvent[] {
  const events: GatewayEvent[] = [
    ...input.turnStartedAlreadyEmitted
      ? []
      : [{ type: "turn_started", runId: input.runId } satisfies GatewayEvent],
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
              label: `确认转入${target}`,
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
