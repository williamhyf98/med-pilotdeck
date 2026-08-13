import { Cuboid, Settings2, ShieldCheck, Table2, X } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import type { MedicalCapabilityId } from '../shared/types';
import type {
  DialogueCapabilities,
  DialogueCorpus,
  ManagedPromptId,
  SamplingSettings,
} from './dialogueTypes';
import { MANAGED_PROMPTS } from './dialogueTypes';

export default function DialogueSettingsPanel({
  open,
  onClose,
  sampling,
  onSamplingChange,
  promptId,
  onPromptIdChange,
  customPrompt,
  onCustomPromptChange,
  ragAvailable,
  ragEnabled,
  onRagEnabledChange,
  thinkEnabled,
  onThinkEnabledChange,
  corpora,
  selectedCorpusIds,
  onSelectedCorpusIdsChange,
  ragTopK,
  onRagTopKChange,
  capabilities,
  onOpenCapability,
}: {
  open: boolean;
  onClose: () => void;
  sampling: SamplingSettings;
  onSamplingChange: (value: SamplingSettings) => void;
  promptId: ManagedPromptId;
  onPromptIdChange: (value: ManagedPromptId) => void;
  customPrompt: string;
  onCustomPromptChange: (value: string) => void;
  ragAvailable: boolean;
  ragEnabled: boolean;
  onRagEnabledChange: (value: boolean) => void;
  thinkEnabled: boolean;
  onThinkEnabledChange: (value: boolean) => void;
  corpora: DialogueCorpus[];
  selectedCorpusIds: string[];
  onSelectedCorpusIdsChange: (value: string[]) => void;
  ragTopK: number;
  onRagTopKChange: (value: number) => void;
  capabilities: DialogueCapabilities;
  onOpenCapability: (value: MedicalCapabilityId) => void;
}) {
  if (!open) return null;
  const openCapability = (value: MedicalCapabilityId) => {
    onClose();
    onOpenCapability(value);
  };

  return (
    <div className="medical-dialogue-drawer-overlay absolute inset-0 z-50 flex justify-end bg-black/20 backdrop-blur-[1px]">
      <button type="button" aria-label="关闭对话配置" className="absolute inset-0" onClick={onClose} />
      <aside className="medical-dialogue-drawer relative flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl">
        <header className="medical-dialogue-drawer-header flex h-16 items-center gap-3 border-b border-border px-5">
          <Settings2 className="h-4 w-4" />
          <div className="mr-auto">
            <h2 className="text-sm font-semibold">系统配置</h2>
            <p className="text-[10px] text-muted-foreground">工作台、采样参数、Prompt 与 RAG</p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose}><X className="h-4 w-4" /></Button>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <h3 className="mb-2 text-[11px] font-semibold">工作台入口</h3>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                className="medical-config-entry"
                onClick={() => openCapability('status')}
              >
                <ShieldCheck className="h-4 w-4" />
                能力状态
              </button>
              <button
                type="button"
                className="medical-config-entry"
                disabled={!capabilities.tables}
                title={capabilities.tables ? '打开表格电子化工作台' : '表格 sidecar 未配置'}
                onClick={() => openCapability('table')}
              >
                <Table2 className="h-4 w-4" />
                表格
              </button>
              <button
                type="button"
                className="medical-config-entry"
                disabled={!capabilities.imaging}
                title={capabilities.imaging ? '打开 3D 影像工作台' : '影像 sidecar 未配置'}
                onClick={() => openCapability('gallery3d')}
              >
                <Cuboid className="h-4 w-4" />
                3D 影像
              </button>
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-[11px] font-semibold">模型采样参数</h3>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Temperature" min={0} max={2} step={0.1} value={sampling.temperature}
                onChange={(temperature) => onSamplingChange({ ...sampling, temperature })} />
              <NumberField label="Top-P" min={0} max={1} step={0.05} value={sampling.topP}
                onChange={(topP) => onSamplingChange({ ...sampling, topP })} />
              <NumberField label="最大输出" min={128} max={1000000} step={128} value={sampling.maxOutputTokens}
                onChange={(maxOutputTokens) => onSamplingChange({ ...sampling, maxOutputTokens })} />
            </div>
            <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
              参数通过 Gateway turnOverrides 传入；提供方不支持时会返回真实错误，不显示假成功。
            </p>
          </section>
          <section>
            <h3 className="mb-2 text-[11px] font-semibold">受管 Prompt</h3>
            <div className="space-y-2">
              {MANAGED_PROMPTS.map((prompt) => (
                <label key={prompt.id} className="flex cursor-pointer gap-2 rounded-lg border border-border p-2.5">
                  <input type="radio" name="medical-prompt" checked={prompt.id === promptId}
                    onChange={() => onPromptIdChange(prompt.id)} />
                  <span>
                    <span className="block text-[11px] font-medium">{prompt.label}</span>
                    <span className="block text-[9px] text-muted-foreground">{prompt.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <Textarea
              value={customPrompt}
              maxLength={2000}
              onChange={(event) => onCustomPromptChange(event.target.value)}
              placeholder="补充输出格式或专业约束（不能覆盖安全边界）"
              className="mt-2 min-h-20 text-[11px]"
            />
          </section>
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold">RAG 语料与 Top-K</h3>
              <span className="text-[9px] text-muted-foreground">{ragAvailable ? '已连接' : '未配置'}</span>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 rounded-lg border border-border p-2.5 text-[10px]">
                <input
                  type="checkbox"
                  checked={ragEnabled}
                  disabled={!ragAvailable}
                  onChange={(event) => onRagEnabledChange(event.target.checked)}
                />
                启用医学检索
              </label>
              <label className="flex items-center gap-2 rounded-lg border border-border p-2.5 text-[10px]">
                <input
                  type="checkbox"
                  checked={thinkEnabled}
                  onChange={(event) => onThinkEnabledChange(event.target.checked)}
                />
                启用模型思考
              </label>
            </div>
            <NumberField label="Top-K" min={1} max={50} step={1} value={ragTopK}
              disabled={!ragAvailable} onChange={onRagTopKChange} />
            <div className="mt-2 space-y-2">
              {corpora.map((corpus) => (
                <label key={corpus.id} className="flex items-start gap-2 rounded-lg border border-border p-2.5">
                  <input
                    type="checkbox"
                    disabled={!corpus.ready}
                    checked={selectedCorpusIds.includes(corpus.id)}
                    onChange={(event) => onSelectedCorpusIdsChange(event.target.checked
                      ? [...selectedCorpusIds, corpus.id]
                      : selectedCorpusIds.filter((id) => id !== corpus.id))}
                  />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium">{corpus.name}</span>
                    <span className="block text-[9px] text-muted-foreground">
                      {corpus.description || corpus.reason || '无描述'}
                      {typeof corpus.documentCount === 'number' ? ` · ${corpus.documentCount} 文档` : ''}
                    </span>
                  </span>
                </label>
              ))}
              {ragAvailable && !corpora.length ? <p className="text-[10px] text-muted-foreground">没有已发布语料。</p> : null}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-[9px] text-muted-foreground">
      {label}
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="mt-1 h-8 text-[11px]"
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
      />
    </label>
  );
}
