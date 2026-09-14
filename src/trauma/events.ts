import type { GatewayEvent } from "../gateway/protocol/types.js";
import type {
  PlacementConfirmationDecision,
  PlacementConfirmationRequest,
  TraumaTurnPhase,
  TraumaTurnProgress,
} from "./runner.js";
import type { AgentTurnResponse, SubStage } from "./types.js";
import { normalizeChineseDisplayText } from "./displayLabels.js";
import {
  SUBSTAGE_ORDER,
  SUBSTAGE_TO_MAIN,
  typicalFacilityForSubStage,
} from "./stageConfig.js";

const PHASE_LABELS: Record<TraumaTurnPhase, string> = {
  validate: "校验并合并表单",
  place: "判断救治级别",
  retrieve: "检索战伤救治规则",
  reason: "综合研判与分级",
};

type TraumaRunnerStepMeta = {
  traumaRunnerStep: true;
  stepNumber?: number;
  phase: string;
  title: string;
  runningTitle: string;
  detail?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
  expectedTotalSteps: number;
  countInTotal: boolean;
};

const TRAUMA_RUNNER_TOTAL_STEPS = 11;

const RUNNER_STEP_LABELS: Record<number, { title: string; runningTitle: string; phaseGroup: string }> = {
  1: { title: "读取病例状态", runningTitle: "正在读取病例状态", phaseGroup: "trauma" },
  2: { title: "合并本轮信息", runningTitle: "正在合并本轮信息", phaseGroup: "trauma" },
  3: { title: "判断救治级别", runningTitle: "正在判断救治级别", phaseGroup: "trauma" },
  4: { title: "采用救治级别", runningTitle: "正在确认救治级别", phaseGroup: "trauma" },
  5: { title: "检索战伤救治规则", runningTitle: "正在检索战伤救治规则", phaseGroup: "rag" },
  6: { title: "合并知识证据", runningTitle: "正在合并知识证据", phaseGroup: "rag" },
  7: { title: "生成结果", runningTitle: "正在生成结果", phaseGroup: "reason" },
  8: { title: "判断后送门控", runningTitle: "正在判断后送门控", phaseGroup: "reason" },
  9: { title: "标记引用依据", runningTitle: "正在标记引用依据", phaseGroup: "reason" },
  10: { title: "整理推演流程图", runningTitle: "正在整理推演流程图/保存推演结果", phaseGroup: "reason" },
  11: { title: "保存推演结果", runningTitle: "正在整理推演流程图/保存推演结果", phaseGroup: "write" },
};

const RUNNER_PHASE_LABELS: Record<string, { title: string; runningTitle: string; phaseGroup: string }> = {
  build_partial_response_and_snapshot: {
    title: "整理部分推演结果",
    runningTitle: "正在整理部分推演结果",
    phaseGroup: "reason",
  },
  persist_partial_snapshot: {
    title: "保存部分推演结果",
    runningTitle: "正在保存部分推演结果",
    phaseGroup: "write",
  },
};

function citationsFromResponse(response: AgentTurnResponse) {
  const promptEvidence = response.evidence.filter((chunk) => chunk.selectedForPrompt);
  return promptEvidence.map((chunk, index) => ({
    index: index + 1,
    title: normalizeChineseDisplayText(chunk.documentTitle),
    section: normalizeChineseDisplayText(chunk.section || chunk.article || "未标注章节"),
  }));
}

function runnerStepLabel(step: number, phase: string) {
  if (RUNNER_PHASE_LABELS[phase]) return RUNNER_PHASE_LABELS[phase];
  return RUNNER_STEP_LABELS[step] ?? {
    title: phase,
    runningTitle: `正在执行 ${phase}`,
    phaseGroup: "trauma",
  };
}

function runnerStepPayload(input: {
  step?: number;
  phase: string;
  title?: string;
  runningTitle?: string;
  detail?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
  countInTotal?: boolean;
}): TraumaRunnerStepMeta {
  const label = typeof input.step === "number"
    ? runnerStepLabel(input.step, input.phase)
    : { title: input.title ?? input.phase, runningTitle: input.runningTitle ?? input.title ?? input.phase };
  return {
    traumaRunnerStep: true,
    stepNumber: input.step,
    phase: input.phase,
    title: input.title ?? label.title,
    runningTitle: input.runningTitle ?? label.runningTitle,
    detail: input.detail,
    durationMs: input.durationMs,
    details: input.details,
    expectedTotalSteps: TRAUMA_RUNNER_TOTAL_STEPS,
    countInTotal: input.countInTotal ?? true,
  };
}

function previewPayload(payload: TraumaRunnerStepMeta): string {
  return JSON.stringify(payload);
}

/**
 * 把推演阶段映射成工具调用事件，让等待期间的界面有可见进度，
 * 而不是整轮结束前一直停在「连接中」。
 */
export function traumaProgressEvents(input: {
  progress: TraumaTurnProgress;
  runId: string;
}): GatewayEvent[] {
  const { progress, runId } = input;
  if ("kind" in progress && progress.kind === "attachment_interpretation") {
    // 工位 I 的支线进度不占用主线步骤编号，暂不映射为网关事件（后续任务按需接入）。
    return [];
  }
  if ("kind" in progress && progress.kind === "runner_step") {
    const label = runnerStepLabel(progress.step, progress.phase);
    const payload = runnerStepPayload({
      step: progress.step,
      phase: label.phaseGroup,
      title: progress.title,
      runningTitle: progress.status === "started" ? progress.title : undefined,
      detail: progress.detail,
      durationMs: progress.status === "finished" ? progress.durationMs : undefined,
      details: progress.details,
    });
    const toolCallId = `trauma-step-${progress.step}:${runId}`;
    if (progress.status === "started") {
      return [{
        type: "tool_call_started",
        toolCallId,
        name: payload.title,
        argsPreview: previewPayload(payload),
        runId,
      }];
    }
    return [{
      type: "tool_call_finished",
      toolCallId,
      toolName: payload.title,
      ok: progress.ok,
      resultPreview: previewPayload(payload),
      runId,
    }];
  }
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

export function traumaExtractionEvents(input: {
  runId: string;
  status: "started" | "finished";
  ok?: boolean;
  detail?: string;
}): GatewayEvent[] {
  const payload = runnerStepPayload({
    phase: "extract",
    title: "大模型信息抽取",
    runningTitle: "正在进行大模型信息抽取",
    detail: input.detail,
    countInTotal: false,
  });
  const toolCallId = `trauma-extraction:${input.runId}`;
  if (input.status === "started") {
    return [{
      type: "tool_call_started",
      toolCallId,
      name: payload.title,
      argsPreview: previewPayload(payload),
      runId: input.runId,
    }];
  }
  return [{
    type: "tool_call_finished",
    toolCallId,
    toolName: payload.title,
    ok: input.ok !== false,
    resultPreview: previewPayload(payload),
    runId: input.runId,
  }];
}

export function traumaPostAnswerProcessEvents(input: {
  runId: string;
  status: "started" | "finished";
}): GatewayEvent[] {
  const payload = runnerStepPayload({
    phase: "reason",
    title: "整理推演流程图/保存推演结果",
    runningTitle: "正在整理推演流程图/保存推演结果",
    countInTotal: false,
  });
  const toolCallId = `trauma-post-answer:${input.runId}`;
  if (input.status === "started") {
    return [{
      type: "tool_call_started",
      toolCallId,
      name: payload.title,
      argsPreview: previewPayload(payload),
      runId: input.runId,
    }];
  }
  return [{
    type: "tool_call_finished",
    toolCallId,
    toolName: payload.title,
    ok: true,
    resultPreview: previewPayload(payload),
    runId: input.runId,
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

const PROPOSED_PREFIX = "采用建议：";
const ALTERNATIVE_PREFIX = "改用：";

/**
 * 确认卡里可选的备选子级：与录入表单的级别单选保持同一套过滤规则——
 * 从「当前已采用子级」起往后的所有子级（更早的子级不允许回退）。
 * 没有当前子级时（首轮）则开放全部子级。
 */
function alternativeSubStages(request: PlacementConfirmationRequest): SubStage[] {
  const currentIndex = request.current.subStage
    ? SUBSTAGE_ORDER.indexOf(request.current.subStage)
    : 0;
  return SUBSTAGE_ORDER
    .slice(Math.max(0, currentIndex))
    .filter((subStage) => subStage !== request.proposed.subStage);
}

export function placementConfirmationOptions(request: PlacementConfirmationRequest) {
  // 第一项永远是大模型的建议，并带上它给出的判定理由。
  const options = [{
    label: `${PROPOSED_PREFIX}${placementLabel(
      request.proposed.stage!,
      request.proposed.subStage!,
      typicalFacilityForSubStage(request.proposed.subStage!).name,
    )}`,
    description: request.proposed.rationale,
  }];
  for (const subStage of alternativeSubStages(request)) {
    const isCurrent = subStage === request.current.subStage;
    options.push({
      label: `${ALTERNATIVE_PREFIX}${placementLabel(
        SUBSTAGE_TO_MAIN[subStage],
        subStage,
        isCurrent ? request.current.facilityName : typicalFacilityForSubStage(subStage).name,
      )}`,
      description: isCurrent
        ? "按当前已采用级别继续检索并生成方案"
        : "以该级别作为本轮推演基线继续检索并生成方案",
    });
  }
  return options;
}

export function parsePlacementConfirmation(
  request: PlacementConfirmationRequest,
  selected: string | undefined,
): PlacementConfirmationDecision {
  // 未作答、被忽略或落在选项之外，一律按建议继续，保证流程不会卡死。
  if (!selected || selected.startsWith(PROPOSED_PREFIX)) return { choice: "proposed" };
  const matched = alternativeSubStages(request).find((subStage) =>
    selected.startsWith(`${ALTERNATIVE_PREFIX}${MAIN_STAGE_LABELS[SUBSTAGE_TO_MAIN[subStage]]} · ${SUBSTAGE_LABELS[subStage]}`));
  if (!matched) return { choice: "proposed" };
  return { choice: "selected", stage: SUBSTAGE_TO_MAIN[matched], subStage: matched };
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
  /** When true (default), emit the completed answer as a fallback delta. */
  includeAssistantText?: boolean;
}): GatewayEvent[] {
  const events: GatewayEvent[] = [
    ...input.turnStartedAlreadyEmitted
      ? []
      : [{ type: "turn_started", runId: input.runId } satisfies GatewayEvent],
    ...(input.includeAssistantText === false
      ? []
      : [{
        type: "assistant_text_delta",
        text: normalizeChineseDisplayText(input.response.naturalLanguageAnswer),
        citations: citationsFromResponse(input.response),
        runId: input.runId,
      } satisfies GatewayEvent]),
  ];

  events.push({
    type: "turn_completed",
    usage: {},
    finishReason: "completed",
    runId: input.runId,
  });
  return events;
}
