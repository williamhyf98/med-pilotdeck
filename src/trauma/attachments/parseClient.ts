import { payloadFromTool } from "../rag/client.js";
import type { TraumaAttachmentRef } from "../types.js";

export const TRAUMA_PARSE_TOOL_NAME = "mcp__med-tools__med_parse_medical";

export type TraumaParsedAttachment = {
  name: string;
  path: string;
  /** 本地解析出的文本摘要：PDF 正文、CDA 检验项、DICOM 元数据。 */
  summary: string;
  /** DICOM / PDF 渲染出的预览 PNG 绝对路径。 */
  pngPaths: string[];
  ok: boolean;
  warnings: string[];
};

export type TraumaParseClient = {
  parse(input: {
    attachment: TraumaAttachmentRef;
    signal?: AbortSignal;
  }): Promise<TraumaParsedAttachment>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function failed(
  attachment: TraumaAttachmentRef,
  reason: string,
): TraumaParsedAttachment {
  return {
    name: attachment.name,
    path: attachment.path,
    summary: "",
    pngPaths: [],
    ok: false,
    warnings: [`附件 ${attachment.name} 解析失败：${reason}`],
  };
}

/**
 * 单个附件解析失败不应中断整个工位——其余附件仍然有判读价值。
 * 所以这里把异常形态收敛成 ok:false 的条目，由 station 决定如何呈现。
 */
export function normalizeParsePayload(
  attachment: TraumaAttachmentRef,
  payload: unknown,
): TraumaParsedAttachment {
  if (!isRecord(payload)) {
    return failed(attachment, `返回形态不是对象（${typeof payload}）`);
  }
  const summary = typeof payload.summary === "string" && payload.summary
    ? payload.summary
    : typeof payload.report === "string"
      ? payload.report
      : "";
  return {
    name: attachment.name,
    path: attachment.path,
    summary,
    pngPaths: stringsOf(payload.png_paths),
    ok: payload.ok !== false,
    warnings: stringsOf(payload.warnings),
  };
}

export function createMcpTraumaParseClient(
  callTool: (name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>,
): TraumaParseClient {
  return {
    async parse({ attachment, signal }) {
      try {
        const raw = await callTool(
          TRAUMA_PARSE_TOOL_NAME,
          {
            path: attachment.path,
            // 只取本地预处理产物，跳过通用医学的 G9 长报告。
            skip_vlm: true,
            // material 表示这是素材而非终结性回答，不结束本轮。
            continuation_mode: "material",
          },
          signal,
        );
        return normalizeParsePayload(attachment, payloadFromTool(raw));
      } catch (error) {
        if (signal?.aborted) throw error;
        return failed(attachment, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
