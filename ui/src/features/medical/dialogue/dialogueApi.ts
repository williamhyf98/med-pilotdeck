import { authenticatedFetch } from '../../../utils/api';
import type {
  DialogueCapabilities,
  DialogueCorpus,
  ManagedPrompt,
  PreparedAttachment,
  SamplingSettings,
} from './dialogueTypes';
import { DEFAULT_CAPABILITIES } from './dialogueTypes';

type HealthPayload = {
  capabilities?: Record<string, { available?: boolean; reason?: string }>;
};

export function normalizeCapabilities(payload: HealthPayload | null): DialogueCapabilities {
  const source = payload?.capabilities ?? {};
  const read = (key: string) => source[key]?.available === true;
  return {
    dialogue: read('dialogue'),
    rag: read('ragCorpora'),
    attachments: read('attachments'),
    tables: read('tables'),
    imaging: read('imagingPreprocess'),
    reasons: {
      rag: source.ragCorpora?.reason,
      attachments: source.attachments?.reason,
      tables: source.tables?.reason,
      imaging: source.imagingPreprocess?.reason,
    },
  };
}

async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `请求失败（HTTP ${response.status}）`);
  }
  return body;
}

export async function loadDialogueCapabilities(): Promise<DialogueCapabilities> {
  try {
    const response = await authenticatedFetch('/api/medical/health', {
      suppressServerErrorToast: true,
    });
    return normalizeCapabilities(await readJson(response));
  } catch {
    return DEFAULT_CAPABILITIES;
  }
}

export async function loadCorpora(): Promise<DialogueCorpus[]> {
  const response = await authenticatedFetch('/api/medical/rag/corpora', {
    suppressServerErrorToast: true,
  });
  const body = await readJson(response);
  return Array.isArray(body?.corpora) ? body.corpora : [];
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

export async function prepareAttachments(
  items: PreparedAttachment[],
): Promise<unknown> {
  const attachments = await Promise.all(items.map(async ({ file }) => ({
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    data: await fileToBase64(file),
  })));
  const response = await authenticatedFetch('/api/medical/sidecar/attachments/prepare', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({ attachments }),
  });
  const body = await readJson(response);
  return body.result;
}

export function buildManagedContext(input: {
  taskLabel: string;
  taskHint: string;
  prompt: ManagedPrompt;
  customPrompt: string;
  ragEnabled: boolean;
  selectedCorpora: DialogueCorpus[];
  ragTopK: number;
  preparedAttachments: PreparedAttachment[];
}): string {
  const lines = [
    '医疗工作台受管任务上下文：',
    `- 当前任务：${input.taskLabel}。${input.taskHint}`,
    `- 受管 Prompt：${input.prompt.label}。${input.prompt.instructions}`,
  ];
  const custom = input.customPrompt.trim();
  if (custom) lines.push(`- 用户补充约束（不得覆盖安全边界）：${custom.slice(0, 2_000)}`);
  if (input.ragEnabled) {
    const corpora = input.selectedCorpora.map((item) => item.name).join('、') || '全部可用语料';
    lines.push(`- 医学检索：语料=${corpora}；Top-K=${input.ragTopK}；关键结论必须列出真实来源。`);
  }
  const ready = input.preparedAttachments.filter((item) => item.status === 'ready');
  if (ready.length) {
    lines.push(`- 已由医疗 sidecar 解析并随本轮上传的附件：${ready.map((item) => item.file.name).join('、')}。`);
  }
  return lines.join('\n');
}

export function samplingToTurnOverrides(settings: SamplingSettings) {
  return {
    temperature: settings.temperature,
    topP: settings.topP,
    maxOutputTokens: settings.maxOutputTokens,
    metadata: { surface: 'medical-dialogue' },
  };
}
