import type { GatewayEvent } from "../gateway/protocol/types.js";
import type {
  PlacementConfirmationDecision,
  PlacementConfirmationRequest,
  TraumaTurnProgress,
} from "./runner.js";
import type { AgentTurnResponse } from "./types.js";
import { normalizeChineseDisplayText } from "./displayLabels.js";
import { typicalFacilityForSubStage } from "./stageConfig.js";

const PHASE_LABELS: Record<TraumaTurnProgress["phase"], string> = {
  validate: "校验并合并表单",
  place: "判断救治级别",
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
  emergency_treatment: "紧急处置",
  surgical_resuscitation: "外科复苏",
};

const MAIN_STAGE_LABELS: Record<string, string> = {
  battlefield_first_aid: "Ⅰ级·战现场急救",
  early_treatment: "Ⅱ级·早期救治",
};

export const PLACEMENT_QUESTION = "请选择本轮后续推演采用的主级和子级";

function placementLabel(stage: string, subStage: string, facility?: string | null): string {
  const main = MAIN_STAGE_LABELS[stage] ?? stage;
  const sub = SUBSTAGE_LABELS[subStage] ?? subStage;
  return `${main} · ${sub}${facility ? `（${facility}）` : ""}`;
}

export function placementConfirmationOptions(request: PlacementConfirmationRequest) {
  const options = [{
    label: `采用建议：${placementLabel(
      request.proposed.stage!,
      request.proposed.subStage!,
      typicalFacilityForSubStage(request.proposed.subStage!).name,
    )}`,
    description: request.proposed.rationale,
  }];
  if (request.current.stage && request.current.subStage) {
    options.push({
      label: `保持当前：${placementLabel(
        request.current.stage,
        request.current.subStage,
        request.current.facilityName,
      )}`,
      description: "按当前已采用级别继续检索并生成方案",
    });
  }
  return options;
}

export function parsePlacementConfirmation(
  request: PlacementConfirmationRequest,
  selected: string | undefined,
): PlacementConfirmationDecision {
  if (selected?.startsWith("采用建议：")) return { choice: "proposed" };
  return { choice: "current" };
}

/**
 * 工位 B 完成后的 Gate 只作为建议随正文返回，不再产生第二张确认卡。
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
      text: normalizeChineseDisplayText(input.response.naturalLanguageAnswer),
      runId: input.runId,
    },
  ];

  events.push({
    type: "turn_completed",
    usage: {},
    finishReason: "completed",
    runId: input.runId,
  });
  return events;
}
