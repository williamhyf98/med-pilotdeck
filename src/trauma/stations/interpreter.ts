import type { TraumaParseClient, TraumaParsedAttachment } from "../attachments/parseClient.js";
import { compactCaseStateForDownstream } from "../factMerge.js";
import type { StructuredModelClient, TraumaImageInput } from "../modelClient.js";
import {
  INTERPRETATION_OUTPUT_SCHEMA,
  validateAttachmentInterpretation,
} from "../schemas.js";
import type {
  AttachmentInterpretationOutput,
  CaseState,
  TraumaAttachmentRef,
} from "../types.js";
import { INTERPRETATION_SYSTEM_PROMPT } from "./interpreterPrompt.js";

/** 与 pilotdeck.yaml 的 multimodal.maxImagesPerRequest 对齐。 */
export const MAX_INTERPRETATION_IMAGES = 8;

export type InterpretationResult = {
  text: string;
  fileNames: string[];
};

export type InterpretationStation = {
  interpret(input: {
    state: CaseState;
    attachments: TraumaAttachmentRef[];
    signal?: AbortSignal;
  }): Promise<InterpretationResult>;
};

export type InterpretationStationDeps = {
  model: StructuredModelClient;
  parse: TraumaParseClient;
  /** 读取预览 PNG 并转成 base64；读不到时返回 null。 */
  readImage: (path: string) => Promise<TraumaImageInput | null>;
  /** 判读模型是否支持 image 输入；trauma 路径绕过了自动降级，必须自己查。 */
  supportsImages: boolean;
};

export function renderInterpretation(output: AttachmentInterpretationOutput): string {
  const blocks = output.attachments.map((item) => (
    `· ${item.fileName}\n  关键发现：${item.keyFindings}\n  创伤相关性：${item.traumaRelevance}`
  ));
  if (output.overall.trim()) {
    blocks.push(`综合判读：${output.overall.trim()}`);
  }
  return blocks.join("\n");
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === "AbortError");
}

function describeAttachment(parsed: TraumaParsedAttachment): Record<string, unknown> {
  return {
    fileName: parsed.name,
    parsed: parsed.ok,
    // 单个附件的本地解析文本可能很长，这里截断——判读只需要要点。
    summary: parsed.summary.slice(0, 4000),
    previewImageCount: parsed.pngPaths.length,
    warnings: parsed.warnings,
  };
}

async function collectImages(
  parsedList: TraumaParsedAttachment[],
  readImage: InterpretationStationDeps["readImage"],
): Promise<TraumaImageInput[]> {
  const images: TraumaImageInput[] = [];
  // 按附件顺序取，超出上限就截断——靠前的附件通常是用户最关心的那份。
  for (const parsed of parsedList) {
    for (const path of parsed.pngPaths) {
      if (images.length >= MAX_INTERPRETATION_IMAGES) return images;
      const image = await readImage(path).catch(() => null);
      if (image) images.push(image);
    }
  }
  return images;
}

export function createInterpretationStation(
  deps: InterpretationStationDeps,
): InterpretationStation {
  return {
    async interpret(input) {
      if (input.attachments.length === 0) {
        return { text: "", fileNames: [] };
      }
      try {
        const parsedList: TraumaParsedAttachment[] = [];
        for (const attachment of input.attachments) {
          parsedList.push(await deps.parse.parse({ attachment, signal: input.signal }));
        }

        const images = deps.supportsImages
          ? await collectImages(parsedList, deps.readImage)
          : [];
        const truncatedImages = parsedList
          .reduce((sum, parsed) => sum + parsed.pngPaths.length, 0) > images.length;

        const output = await deps.model.completeJson<AttachmentInterpretationOutput>({
          name: "trauma_interpret_attachments",
          system: INTERPRETATION_SYSTEM_PROMPT,
          user: JSON.stringify({
            caseHistory: compactCaseStateForDownstream(input.state),
            attachments: parsedList.map(describeAttachment),
            previewImagesTruncated: truncatedImages,
            imageCapabilityAvailable: deps.supportsImages,
          }),
          schema: INTERPRETATION_OUTPUT_SCHEMA,
          validate: validateAttachmentInterpretation,
          ...(images.length > 0 ? { images } : {}),
          signal: input.signal,
        });

        const text = renderInterpretation(output);
        if (!text.trim()) return { text: "", fileNames: [] };
        return { text, fileNames: parsedList.map((parsed) => parsed.name) };
      } catch (error) {
        // 中止要向上传播，让 runner 收束支线；其余故障一律降级为空判读，
        // 主线继续推演而不是整轮失败。
        if (isAbort(error, input.signal)) throw error;
        return { text: "", fileNames: [] };
      }
    },
  };
}
