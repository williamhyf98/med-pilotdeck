import { authenticatedFetch } from '../../../utils/api';
import type {
  TraumaImageItem,
  TraumaResultSectionId,
  TraumaStageId,
  MedicalPresetInfo,
} from './types';

export type MedicalStreamEvent = {
  event: string;
  data: {
    type?: string;
    requestId?: string | null;
    sessionId?: string | null;
    text?: string;
    phase?: string;
    reason?: string;
    code?: string;
    message?: string;
    recoverable?: boolean;
  };
};

type TraumaAnalyzeInput = {
  stage: TraumaStageId;
  description: string;
  images: TraumaImageItem[];
  profile?: string;
  model?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onEvent: (event: MedicalStreamEvent) => void;
};

export class MedicalApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = 'MedicalApiError';
    this.code = code;
    this.status = status;
  }
}

export async function streamTraumaAnalysis(input: TraumaAnalyzeInput): Promise<void> {
  const images = await Promise.all(
    input.images
      .filter((item): item is TraumaImageItem & { file: File } => Boolean(item.file))
      .map(async (item) => {
        const isDicom = item.file.type === 'application/dicom'
          || /\.(?:dcm|dicom)$/iu.test(item.file.name);
        if (!item.file.type.startsWith('image/') && !isDicom) {
          throw new MedicalApiError(
            'MEDICAL_IMAGE_REQUIRES_PREPROCESSING',
            `${item.name} 需要先由医疗 sidecar 转换为受支持的预览图片。`,
            422,
          );
        }
        const dataUrl = await readFileAsDataUrl(item.file);
        return {
          name: item.name,
          mimeType: isDicom ? 'application/dicom' : item.file.type,
          data: isDicom && dataUrl.includes(',')
            ? `data:application/dicom;base64,${dataUrl.split(',', 2)[1]}`
            : dataUrl,
        };
      }),
  );

  const response = await authenticatedFetch('/api/medical/med-trauma/analyze', {
    method: 'POST',
    suppressServerErrorToast: true,
    signal: input.signal,
    body: JSON.stringify({
      stage: input.stage,
      description: input.description,
      ...(images.length > 0 ? { images } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }),
  });

  if (!response.ok) {
    throw await medicalErrorFromResponse(response);
  }
  if (!response.body) {
    throw new MedicalApiError(
      'MEDICAL_STREAM_UNAVAILABLE',
      '医疗流式响应不可用。',
      502,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    buffer = drainSseBuffer(buffer, input.onEvent, done);
    if (done) break;
  }
}

export async function stopTraumaAnalysis(sessionId: string): Promise<void> {
  const response = await authenticatedFetch('/api/medical/med-trauma/stop', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok && response.status !== 404) {
    throw await medicalErrorFromResponse(response);
  }
}

export function parseTraumaResultSections(
  value: string,
): Record<TraumaResultSectionId, string> {
  const result: Record<TraumaResultSectionId, string> = {
    imaging: '',
    'stage-action': '',
    'specific-action': '',
    evacuation: '',
    safety: '',
  };
  const headings: Array<{
    id: TraumaResultSectionId;
    pattern: RegExp;
  }> = [
    { id: 'imaging', pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:一|1)[、.．]\s*(?:图像|影像|伤情)[^\n]*/u },
    { id: 'stage-action', pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:二|2)[、.．]\s*(?:阶段|本阶段)[^\n]*/u },
    { id: 'specific-action', pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:三|3)[、.．]\s*(?:特异|专项)[^\n]*/u },
    { id: 'evacuation', pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:四|4)[、.．]\s*(?:分类|伤标|后送|交接)[^\n]*/u },
    { id: 'safety', pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:五|5)[、.．]\s*(?:安全|禁忌)[^\n]*/u },
  ];

  const matches = headings
    .map(({ id, pattern }) => {
      const match = pattern.exec(value);
      return match ? { id, index: match.index, contentStart: match.index + match[0].length } : null;
    })
    .filter((item): item is { id: TraumaResultSectionId; index: number; contentStart: number } => Boolean(item))
    .sort((left, right) => left.index - right.index);

  if (matches.length === 0) {
    result.imaging = value.trim();
    return result;
  }

  matches.forEach((match, index) => {
    const next = matches[index + 1];
    result[match.id] = value.slice(match.contentStart, next?.index ?? value.length).trim();
  });
  if (matches[0].index > 0) {
    const preface = value.slice(0, matches[0].index).trim();
    if (preface) result.imaging = [preface, result.imaging].filter(Boolean).join('\n\n');
  }
  return result;
}

function drainSseBuffer(
  source: string,
  onEvent: (event: MedicalStreamEvent) => void,
  flush: boolean,
): string {
  const normalized = source.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remainder = flush ? '' : blocks.pop() ?? '';
  const completeBlocks = flush ? blocks.filter(Boolean) : blocks;

  for (const block of completeBlocks) {
    const parsed = parseSseBlock(block);
    if (parsed) onEvent(parsed);
  }
  if (flush && remainder.trim()) {
    const parsed = parseSseBlock(remainder);
    if (parsed) onEvent(parsed);
  }
  return remainder;
}

function parseSseBlock(block: string): MedicalStreamEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    return {
      event,
      data: JSON.parse(dataLines.join('\n')) as MedicalStreamEvent['data'],
    };
  } catch {
    return null;
  }
}

async function medicalErrorFromResponse(response: Response): Promise<MedicalApiError> {
  try {
    const body = await response.json() as {
      error?: { code?: string; message?: string };
    };
    return new MedicalApiError(
      body.error?.code || 'MEDICAL_REQUEST_FAILED',
      body.error?.message || `医疗请求失败（${response.status}）。`,
      response.status,
    );
  } catch {
    return new MedicalApiError(
      'MEDICAL_REQUEST_FAILED',
      `医疗请求失败（${response.status}）。`,
      response.status,
    );
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(
      new MedicalApiError('MEDICAL_IMAGE_READ_FAILED', `无法读取 ${file.name}。`, 422),
    );
    reader.readAsDataURL(file);
  });
}

let _cachedPresetInfo: MedicalPresetInfo | null = null;

export async function fetchMedicalPresetInfo(): Promise<MedicalPresetInfo> {
  if (_cachedPresetInfo) return _cachedPresetInfo;

  const response = await authenticatedFetch('/api/medical/health');
  if (!response.ok) {
    throw new MedicalApiError(
      'MEDICAL_HEALTH_FAILED',
      `医疗健康检查失败（${response.status}）。`,
      response.status,
    );
  }

  const health = await response.json() as Record<string, unknown>;
  const info: MedicalPresetInfo = {
    presetId: (health.presetId as string) ?? null,
    branding: (health.branding as MedicalPresetInfo['branding']) ?? {
      productName: 'PilotDeck Medical',
      dialogueName: null,
      traumaName: null,
      organizationName: null,
      logoAsset: null,
    },
    features: (health.features as MedicalPresetInfo['features']) ?? {},
    security: (health.security as MedicalPresetInfo['security']) ?? {
      crossSessionMemory: false,
      publicWebSearch: false,
      externalTelemetry: false,
      requireHumanReview: true,
    },
    deployment: (health.deployment as MedicalPresetInfo['deployment']) ?? {
      offlineLevel: 'L1',
    },
    customer: health.customer as MedicalPresetInfo['customer'] | undefined,
    knowledge: health.knowledge as MedicalPresetInfo['knowledge'] | undefined,
    profiles: health.profiles as MedicalPresetInfo['profiles'] | undefined,
  };

  _cachedPresetInfo = info;
  return info;
}

export function clearMedicalPresetInfoCache(): void {
  _cachedPresetInfo = null;
}
