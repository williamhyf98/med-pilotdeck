/**
 * 战创伤长期记忆写入策略（Task 7，§3.7 `feedback_only`）。
 *
 * 战创伤只写 feedback：汇报格式、表达偏好、工作流规则、明确纠错。
 * **生命体征、伤情分级、救治阶段、患者标识一律只留在 Case State**，
 * 不进任何长期记忆。§3.3 的患者病历化是通用医学的能力，战创伤不启用。
 *
 * 三层防线，本模块是第二层：
 *   1. 提示词档案（Task 5 `WAR_TRAUMA_PROFILE`）——告诉模型只许分类出 feedback；
 *   2. **本模块**——在把内容交给提取管线之前，先按规则剔掉临床语句；
 *   3. `allowedTypes` 硬闸（Task 5，`LlmMemoryExtractor.createMemoryNote`）——
 *      即使分类结果被篡改成 `project`，写入依然被丢弃。
 *
 * 为什么第二层不能省：第 1 层是模型判断，会漂；第 3 层只管**类型**，
 * 不管**内容**——一条被判成 feedback 但正文里抄了「收缩压 80mmHg」的笔记
 * 能顺利穿过硬闸。所以必须在进管线前按句子粒度做一次确定性过滤。
 *
 * 只有**用户输入**是候选。助手回答整段不进候选池：它天然由伤情推演、
 * 分级建议、处置方案组成，逐句过滤的收益远小于误放的风险。
 */

import { redact } from "../../context/memory/MemoryPrivacyPolicy.js";
import {
  containsTraumaClinicalContent,
  type ValidatedTraumaPreference,
} from "./TraumaPreferencePolicy.js";

// ── 策略模式 ────────────────────────────────────────────────────────────────

/** 本期实际支持的写入策略。 */
export type TraumaMemoryCaptureMode = "off" | "feedback_only";

/**
 * 配置里允许出现的字面量。`eligible_turns` **本期不实现**——
 * 类型里预留，但解析时拒绝启用并给出明确错误（计划 Task 7）。
 */
export type TraumaMemoryCaptureModeInput = TraumaMemoryCaptureMode | "eligible_turns";

export const DEFAULT_TRAUMA_MEMORY_CAPTURE_MODE: TraumaMemoryCaptureMode = "feedback_only";

export const TRAUMA_MEMORY_CAPTURE_MODES: readonly TraumaMemoryCaptureMode[] = [
  "off",
  "feedback_only",
];

/** `eligible_turns` 被显式拒绝时抛出的错误信息，配置层与 UI 共用同一句话。 */
export const TRAUMA_MEMORY_CAPTURE_ELIGIBLE_TURNS_ERROR =
  'memory.traumaCapture="eligible_turns" 本期未实现，请使用 "off" 或 "feedback_only"。';

/**
 * 归一化配置值。缺省回落到 `feedback_only`。
 *
 * 对 `eligible_turns` **不做静默降级**：静默降级会让用户以为按轮次筛选生效了，
 * 而实际上跑的是全量 feedback 捕获——这是隐私预期上的落差，必须报错。
 */
export function resolveTraumaMemoryCaptureMode(value: unknown): TraumaMemoryCaptureMode {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_TRAUMA_MEMORY_CAPTURE_MODE;
  }
  if (value === "eligible_turns") {
    throw new Error(TRAUMA_MEMORY_CAPTURE_ELIGIBLE_TURNS_ERROR);
  }
  if (value === "off" || value === "feedback_only") {
    return value;
  }
  throw new Error(
    `memory.traumaCapture 必须是 "off" 或 "feedback_only"，收到：${JSON.stringify(value)}`,
  );
}

// ── 轮次状态 ────────────────────────────────────────────────────────────────

/**
 * 本轮的完成情况。只有 `completed` 才可能被捕获——
 * errored / aborted / 模型未完成的 turn 默认不捕获（计划 Task 7）。
 */
export type TraumaTurnStatus = "completed" | "errored" | "aborted" | "incomplete";

// ── 决策结果 ────────────────────────────────────────────────────────────────

export type TraumaMemoryCaptureSkipReason =
  /** 策略为 off。 */
  | "policy_off"
  /** 本轮 errored / aborted / 未产出完整回答。 */
  | "turn_not_completed"
  /** 用户输入为空。 */
  | "empty_input"
  /** 没有可留存的协作规则，且本轮剔除过临床语句。 */
  | "clinical_content_only"
  /** 没有任何 feedback 信号，且本轮不含临床语句（只是普通提问/陈述）。 */
  | "no_feedback_signal"
  /** 过滤 + 脱敏之后没有剩余内容。 */
  | "empty_after_redaction";

export type TraumaMemoryCaptureDecision =
  | {
    capture: false;
    mode: TraumaMemoryCaptureMode;
    reason: TraumaMemoryCaptureSkipReason;
    /** 因临床内容被剔除的语句数，便于审计「这轮丢了多少」。 */
    droppedSegments: number;
  }
  | {
    capture: true;
    mode: TraumaMemoryCaptureMode;
    /** 过滤 + 脱敏后，真正交给提取管线的文本。 */
    text: string;
    /** 被剔除的语句数（临床内容 + 无 feedback 信号）。 */
    droppedSegments: number;
    /** 脱敏命中的字段数（Task 3 的 `removedCount`）。 */
    redactedCount: number;
    /** 脱敏命中的规则标签。 */
    redactedHits: string[];
    /** 目标作用域（projectId），审计用。 */
    scope: string;
  };

export type TraumaMemoryCaptureInput = {
  mode: TraumaMemoryCaptureMode;
  /** 本轮用户原始输入。助手回答不参与捕获。 */
  userText: string;
  turnStatus: TraumaTurnStatus;
  /** 目标作用域（projectId），只用于审计记录。 */
  scope: string;
};

// ── 规则：临床内容（拒绝） ──────────────────────────────────────────────────

/**
 * 命中即整句丢弃。覆盖计划里点名拒绝的五类：
 * 生命体征、伤情分级、救治阶段、患者标识、任何病例医学事实。
 *
 * 宁可误杀不可漏放：一句「回答时不要写血压」会被当成临床内容丢掉，
 * 代价只是少存一条偏好；反向的漏放是把生命体征写进长期记忆。
 */
// ── 规则：feedback 信号（接受） ─────────────────────────────────────────────

/**
 * 命中才保留。对应计划里允许的四类：
 * 明确纠错、稳定展示偏好、汇报格式偏好、工作流规则。
 */
const FEEDBACK_PATTERNS: readonly RegExp[] = [
  // 明确纠错
  /说错|讲错|写错|弄错|错了|不对|不准确|纠正|更正|别再|不要再|我纠正/u,
  // 展示 / 汇报格式偏好
  /格式|排版|结构|条理|分点|列表|表格|标题|小标题|段落|字数|篇幅/u,
  /先给结论|先说结论|结论先行|先.{0,4}再|简洁|简短|精简|详细|展开|啰嗦|冗长/u,
  // 语言与措辞
  /用中文|用英文|中文回答|英文回答|术语|措辞|口径|称呼|语气|风格/u,
  // 工作流规则
  /以后|下次|每次|今后|之后都|一律|统一|默认|始终|保持|习惯|偏好|约定|规则|要求你|记住/u,
  /不用|无需|不必|不要输出|不要显示|不要写|改成|换成|按照|按.{0,6}来/u,
];

// ── 语句切分 ────────────────────────────────────────────────────────────────

/**
 * 按句末标点与换行切分。保留原标点，便于留存内容读起来仍是完整句子。
 *
 * 用 `split` 而不是逐字符扫描：这里只需要「够用」的粒度，
 * 切分不完美的代价是某个长句整体保留或整体丢弃，两个方向都安全。
 */
function splitSegments(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function isClinical(segment: string): boolean {
  return containsTraumaClinicalContent(segment);
}

function hasFeedbackSignal(segment: string): boolean {
  return FEEDBACK_PATTERNS.some((pattern) => pattern.test(segment));
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 判定本轮能否写入长期记忆，以及写入什么。
 *
 * 纯函数，不做 I/O：调用方拿到 `capture: true` 才去落盘，
 * 拿到 `capture: false` 按 `reason` 记一条审计日志即可。
 */
export function evaluateTraumaMemoryCapture(
  input: TraumaMemoryCaptureInput,
): TraumaMemoryCaptureDecision {
  const mode = input.mode;

  if (mode === "off") {
    return { capture: false, mode, reason: "policy_off", droppedSegments: 0 };
  }

  // errored / aborted / 未完成的 turn 默认不捕获：模型没跑完时，
  // 用户输入的语义常常还没被确认，存下来的「规则」可能根本没生效过。
  if (input.turnStatus !== "completed") {
    return { capture: false, mode, reason: "turn_not_completed", droppedSegments: 0 };
  }

  const userText = input.userText?.trim() ?? "";
  if (!userText) {
    return { capture: false, mode, reason: "empty_input", droppedSegments: 0 };
  }

  const segments = splitSegments(userText);
  const kept: string[] = [];
  let clinicalDropped = 0;
  let noSignalDropped = 0;

  for (const segment of segments) {
    // 临床判定优先于 feedback 判定：同一句里两种信号并存时，拒绝方胜出。
    if (isClinical(segment)) {
      clinicalDropped += 1;
      continue;
    }
    if (!hasFeedbackSignal(segment)) {
      noSignalDropped += 1;
      continue;
    }
    kept.push(segment);
  }

  const droppedSegments = clinicalDropped + noSignalDropped;

  if (kept.length === 0) {
    return {
      capture: false,
      mode,
      // 区分两种空结果：审计时含义完全不同。只要剔掉过临床语句就报
      // clinical_content_only——这是隐私相关的信号，比「这轮没规则」更值得留痕。
      reason: clinicalDropped > 0 ? "clinical_content_only" : "no_feedback_signal",
      droppedSegments,
    };
  }

  // 落盘前调用 Task 3 的脱敏策略。留存语句理论上已不含 PHI，
  // 但规则是「所有长期记忆写入都过一遍」，这里不做例外。
  const redacted = redact(kept.join("\n"));
  const text = redacted.text.trim();
  if (!text) {
    return { capture: false, mode, reason: "empty_after_redaction", droppedSegments };
  }

  return {
    capture: true,
    mode,
    text,
    droppedSegments,
    redactedCount: redacted.removedCount,
    redactedHits: redacted.hits,
    scope: input.scope,
  };
}

// ── 与网关的接缝 ────────────────────────────────────────────────────────────

/**
 * 网关侧只认这一个函数签名。判定、脱敏、落盘全在实现里，
 * `InProcessGateway` 不需要知道策略长什么样。
 */
export type TraumaMemoryCaptureSink = (input: {
  sessionId: string;
  preferences: readonly ValidatedTraumaPreference[];
  turnStatus: TraumaTurnStatus;
}) => void;

type CaptureWriterLike = {
  capture(input: { sessionId: string; text: string }): boolean;
};

type CaptureLoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

/**
 * 把策略与写入端组合成网关用的 sink。
 *
 * 每次捕获（含跳过）都记一行审计日志：policy、原因、被删除字段数、目标 scope。
 * 任何异常都被吞掉——记忆写入是旁路，不能影响这一轮的推演结果。
 */
export function createTraumaMemoryCaptureSink(options: {
  writer: CaptureWriterLike;
  mode: TraumaMemoryCaptureMode;
  /** 目标作用域（projectId），审计用。 */
  scope: string;
  logger?: CaptureLoggerLike;
}): TraumaMemoryCaptureSink {
  return (input) => {
    try {
      const decision: TraumaMemoryCaptureDecision = options.mode === "off"
        ? { capture: false, mode: options.mode, reason: "policy_off", droppedSegments: 0 }
        : input.turnStatus !== "completed"
          ? { capture: false, mode: options.mode, reason: "turn_not_completed", droppedSegments: 0 }
          : input.preferences.length === 0
            ? { capture: false, mode: options.mode, reason: "no_feedback_signal", droppedSegments: 0 }
            : {
                capture: true,
                mode: options.mode,
                text: input.preferences.map((preference) => preference.directive).join("\n"),
                droppedSegments: 0,
                redactedCount: input.preferences.reduce(
                  (total, preference) => total + preference.redactedCount,
                  0,
                ),
                redactedHits: Array.from(new Set(
                  input.preferences.flatMap((preference) => preference.redactedHits),
                )),
                scope: options.scope,
              };

      const line = describeTraumaMemoryCaptureDecision(decision, options.scope);
      if (!decision.capture) {
        // policy_off 是稳定状态，逐轮打日志只会刷屏。
        if (decision.reason !== "policy_off") options.logger?.info?.(line);
        return;
      }

      const written = options.writer.capture({
        sessionId: input.sessionId,
        text: decision.text,
      });
      options.logger?.info?.(`${line} written=${written}`);
    } catch (error) {
      options.logger?.warn?.(
        "[memory] 战创伤记忆写入策略异常，本轮跳过：",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

/** 把决策渲染成一行审计日志：policy、原因、被删除字段数、目标 scope。 */
export function describeTraumaMemoryCaptureDecision(
  decision: TraumaMemoryCaptureDecision,
  scope: string,
): string {
  if (!decision.capture) {
    return `[memory] 战创伤记忆写入跳过 policy=${decision.mode} reason=${decision.reason}`
      + ` dropped=${decision.droppedSegments} scope=${scope}`;
  }
  return `[memory] 战创伤记忆写入 policy=${decision.mode} reason=feedback_captured`
    + ` dropped=${decision.droppedSegments} redacted=${decision.redactedCount}`
    + `${decision.redactedHits.length > 0 ? ` hits=${decision.redactedHits.join(",")}` : ""}`
    + ` scope=${decision.scope}`;
}
