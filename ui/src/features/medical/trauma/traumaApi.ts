import { authenticatedFetch } from '../../../utils/api';
import type {
  TraumaImageCategoryId,
  TraumaImageItem,
  TraumaResultSectionId,
  TraumaStageId,
} from '../shared/types';
import {
  MedicalApiError,
  parseTraumaResultSections,
} from '../shared/medicalApi';

export type TraumaMode = 'eval' | 'plain';

export type OrderedTraumaImage = TraumaImageItem & {
  image_id: string;
  label: string;
  index: number;
  dicom?: boolean;
};

export type TraumaDemoSummary = {
  id: string;
  title: string;
  description?: string;
  historicalEvaluation?: boolean;
};

export type TraumaDemoCase = TraumaDemoSummary & {
  stage: TraumaStageId;
  images: OrderedTraumaImage[];
  results?: Partial<Record<TraumaResultSectionId, string>>;
};

export type TraumaStreamEvent = {
  event: string;
  data: {
    sessionId?: string | null;
    text?: string;
    reason?: string;
    message?: string;
  };
};

type StreamInput = {
  stage: TraumaStageId;
  description: string;
  images: OrderedTraumaImage[];
  mode: TraumaMode;
  model?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onEvent: (event: TraumaStreamEvent) => void;
};

type UnknownRecord = Record<string, unknown>;

const RESULT_IDS: TraumaResultSectionId[] = [
  'imaging',
  'stage-action',
  'specific-action',
  'evacuation',
  'safety',
];

export { MedicalApiError, parseTraumaResultSections };

export function reorderImages(
  images: OrderedTraumaImage[],
  from: number,
  to: number,
): OrderedTraumaImage[] {
  if (from === to || from < 0 || to < 0 || from >= images.length || to >= images.length) {
    return images;
  }
  const next = [...images];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.map((image, index) => ({ ...image, index }));
}

export function isDicomFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type === 'application/dicom' || /\.(?:dcm|dicom)$/iu.test(file.name);
}

export async function loadTraumaDemoIndex(): Promise<TraumaDemoSummary[]> {
  const response = await authenticatedFetch('/api/medical/demo', {
    suppressServerErrorToast: true,
  });
  if (!response.ok) throw await apiError(response, '演示案例索引加载失败');
  const payload = await response.json() as unknown;
  const candidates = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.cases)
      ? payload.cases
      : [];
  return candidates.flatMap(normalizeDemoSummary);
}

export async function loadTraumaDemoCase(id: string): Promise<TraumaDemoCase> {
  const response = await authenticatedFetch(`/api/medical/demo/${encodeURIComponent(id)}`, {
    suppressServerErrorToast: true,
  });
  if (!response.ok) throw await apiError(response, '演示案例加载失败');
  return normalizeDemoCase(await response.json() as unknown, id);
}

export async function probeTraumaModel(model?: string): Promise<string> {
  const response = await authenticatedFetch('/api/medical/models/probe', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({ ...(model ? { model } : {}), capability: 'med-trauma' }),
  });
  if (!response.ok) throw await apiError(response, '模型探活失败');
  const payload = await response.json() as UnknownRecord;
  if (payload.ok === false || payload.available === false) {
    throw new MedicalApiError('MEDICAL_MODEL_UNAVAILABLE', '模型当前不可用。', 503);
  }
  return typeof payload.message === 'string' && payload.message.trim()
    ? payload.message.trim()
    : '模型可用';
}

export async function streamTraumaAnalysis(input: StreamInput): Promise<void> {
  const images = await Promise.all(input.images.map(async (item) => {
    const dicom = item.file ? isDicomFile(item.file) : Boolean(item.dicom);
    const base = {
      image_id: item.image_id,
      category: item.category,
      label: item.label,
      index: item.index,
      name: item.name,
    };
    if (!item.file) {
      if (item.demo && item.previewUrl?.startsWith('/api/medical/demo/images/')) {
        const response = await authenticatedFetch(item.previewUrl, {
          signal: input.signal,
          suppressServerErrorToast: true,
        });
        if (!response.ok) throw await apiError(response, '授权演示图片加载失败');
        const contentType = response.headers.get('content-type')?.split(';')[0] || '';
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
          throw new MedicalApiError(
            'MEDICAL_DEMO_IMAGE_INVALID',
            `${item.name} 不是受支持的授权演示图片。`,
            422,
          );
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > 8 * 1024 * 1024) {
          throw new MedicalApiError(
            'MEDICAL_DEMO_IMAGE_TOO_LARGE',
            `${item.name} 超过 8 MB 安全上限。`,
            413,
          );
        }
        return {
          ...base,
          demo: true,
          dicom: false,
          mimeType: contentType,
          data: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`,
        };
      }
      return { ...base, demo: Boolean(item.demo), dicom };
    }
    if (dicom) {
      return { ...base, dicom: true, preprocessing_required: true };
    }
    if (!item.file.type.startsWith('image/')) {
      throw new MedicalApiError(
        'MEDICAL_IMAGE_REQUIRES_PREPROCESSING',
        `${item.name} 不是受支持的图片格式。`,
        422,
      );
    }
    return {
      ...base,
      mimeType: item.file.type,
      data: await readFileAsDataUrl(item.file),
    };
  }));

  const response = await authenticatedFetch('/api/medical/med-trauma/analyze', {
    method: 'POST',
    suppressServerErrorToast: true,
    signal: input.signal,
    body: JSON.stringify({
      stage: input.stage,
      description: input.description,
      mode: input.mode,
      profile: 'trauma-team',
      images,
      ...(input.model ? { model: input.model } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }),
  });
  if (!response.ok) throw await apiError(response, '战创伤研判请求失败');
  if (!response.body) {
    throw new MedicalApiError('MEDICAL_STREAM_UNAVAILABLE', '医疗流式响应不可用。', 502);
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
    throw await apiError(response, '停止研判失败');
  }
}

function normalizeDemoSummary(value: unknown): TraumaDemoSummary[] {
  if (!isRecord(value)) return [];
  const id = stringValue(value.id ?? value.case_id);
  const title = stringValue(value.title ?? value.label);
  if (!id || !title) return [];
  return [{
    id,
    title,
    description: stringValue(value.description) || undefined,
    historicalEvaluation: value.historicalEvaluation === true
      || value.historical_evaluation === true
      || value.static_evaluation === true,
  }];
}

function normalizeDemoCase(value: unknown, fallbackId: string): TraumaDemoCase {
  if (!isRecord(value)) {
    throw new MedicalApiError('MEDICAL_DEMO_INVALID', '演示案例格式无效。', 502);
  }
  const nested = isRecord(value.case) ? value.case : value;
  const summary = normalizeDemoSummary({
    ...nested,
    id: nested.id ?? nested.case_id ?? fallbackId,
    title: nested.title ?? nested.label ?? fallbackId,
  })[0];
  const stageOrder = Array.isArray(nested.stageOrder) ? nested.stageOrder : [];
  const stages = isRecord(nested.stages) ? nested.stages : {};
  const selectedStageKey = stringValue(stageOrder[0]) || Object.keys(stages)[0] || '';
  const stageRecord = isRecord(stages[selectedStageKey]) ? stages[selectedStageKey] : {};
  const description = stringValue(nested.description ?? stageRecord.description);
  if (!summary || !description) {
    throw new MedicalApiError('MEDICAL_DEMO_INVALID', '演示案例缺少标题或伤情描述。', 502);
  }
  const stage = normalizeStage(
    nested.stage
    ?? stageRecord.stageKey
    ?? stageRecord.stageType
    ?? selectedStageKey,
  );
  const sourceImages = Array.isArray(nested.images)
    ? nested.images
    : normalizeStageImageMap(stageRecord.images, fallbackId);
  const images = sourceImages.flatMap((candidate, index) => normalizeDemoImage(candidate, index));
  return {
    ...summary,
    historicalEvaluation: summary.historicalEvaluation
      || typeof stageRecord.referenceGt === 'string',
    description,
    stage,
    images,
    results: normalizeResults(
      nested.results
      ?? nested.evaluation
      ?? stageRecord.results
      ?? stageRecord.referenceGt,
    ),
  };
}

function normalizeStageImageMap(value: unknown, caseId: string): unknown[] {
  if (!isRecord(value)) return [];
  const items = isRecord(value.items) ? value.items : value;
  return Object.entries(items).flatMap(([key, raw], index) => {
    const preview = stringValue(raw);
    if (!preview) return [];
    return [{
      image_id: `${caseId}-${key}`,
      id: `${caseId}-${key}`,
      name: preview.split('/').pop() || key,
      label: key,
      category: normalizeCategory(key),
      index,
      preview_url: preview,
      demo: true,
    }];
  });
}

function normalizeDemoImage(value: unknown, fallbackIndex: number): OrderedTraumaImage[] {
  if (!isRecord(value)) return [];
  const imageId = stringValue(value.image_id ?? value.id);
  const category = normalizeCategory(value.category);
  const label = stringValue(value.label ?? value.name);
  const indexValue = typeof value.index === 'number' ? value.index : fallbackIndex;
  if (!imageId || !label) return [];
  return [{
    id: imageId,
    image_id: imageId,
    name: stringValue(value.name) || label,
    category,
    label,
    index: indexValue,
    previewUrl: stringValue(value.preview_url ?? value.previewUrl) || undefined,
    demo: true,
    dicom: value.dicom === true,
  }];
}

function normalizeResults(value: unknown): Partial<Record<TraumaResultSectionId, string>> | undefined {
  if (typeof value === 'string') return parseTraumaResultSections(value);
  if (!isRecord(value)) return undefined;
  const result: Partial<Record<TraumaResultSectionId, string>> = {};
  RESULT_IDS.forEach((id) => {
    const content = stringValue(value[id]);
    if (content) result[id] = content;
  });
  return Object.keys(result).length ? result : undefined;
}

function normalizeCategory(value: unknown): TraumaImageCategoryId {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'injury' || normalized.includes('wound')) return 'wound';
  if (normalized.includes('xray') || normalized.includes('x-ray')) return 'xray';
  if (normalized.includes('ecg')) return 'ecg';
  if (normalized.includes('ct')) return 'ct';
  return normalized === 'wound' || normalized === 'xray' || normalized === 'ecg'
    || value === 'ct' || value === 'other'
    ? normalized as TraumaImageCategoryId
    : 'other';
}

function normalizeStage(value: unknown): TraumaStageId {
  const normalized = String(value || '').toLowerCase().replace(/_/gu, '-');
  return normalized === 'point-of-injury' || normalized === 'field-triage'
    || normalized === 'reception-treatment' || normalized === 'critical-care'
    || normalized === 'surgery' || normalized === 'decontamination'
    ? normalized
    : 'point-of-injury';
}

function drainSseBuffer(
  source: string,
  onEvent: (event: TraumaStreamEvent) => void,
  flush: boolean,
): string {
  const blocks = source.replace(/\r\n/gu, '\n').split('\n\n');
  const remainder = flush ? '' : blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const lines: string[] = [];
    block.split('\n').forEach((line) => {
      if (line.startsWith('event:')) event = line.slice(6).trim() || event;
      if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
    });
    if (!lines.length) continue;
    try {
      onEvent({ event, data: JSON.parse(lines.join('\n')) as TraumaStreamEvent['data'] });
    } catch {
      // Ignore malformed heartbeat/event blocks without breaking the stream.
    }
  }
  return remainder;
}

async function apiError(response: Response, fallback: string): Promise<MedicalApiError> {
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    return new MedicalApiError(
      body.error?.code || 'MEDICAL_REQUEST_FAILED',
      body.error?.message || `${fallback}（${response.status}）。`,
      response.status,
    );
  } catch {
    return new MedicalApiError('MEDICAL_REQUEST_FAILED', `${fallback}（${response.status}）。`, response.status);
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
