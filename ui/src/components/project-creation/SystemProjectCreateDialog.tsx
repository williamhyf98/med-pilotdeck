import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../../utils/api';

export const SYSTEM_PROJECT_TYPES = [
  { id: 'general_medicine', label: '通用医学' },
  { id: 'war_trauma', label: '战创伤医学' },
] as const;

export type SystemProjectTypeId = (typeof SYSTEM_PROJECT_TYPES)[number]['id'];

type SystemProjectCreateDialogProps = {
  onClose: () => void;
  onCreated: (project: Record<string, unknown>) => void;
  onOpenLegacyPathWizard?: () => void;
};

export default function SystemProjectCreateDialog({
  onClose,
  onCreated,
  onOpenLegacyPathWizard,
}: SystemProjectCreateDialogProps) {
  const [displayName, setDisplayName] = useState('');
  const [projectType, setProjectType] = useState<SystemProjectTypeId>('general_medicine');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const name = displayName.trim();
    if (!name) {
      setError('请填写项目名称');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await api.createSystemProject({
        displayName: name,
        type: projectType,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || '创建项目失败');
      }
      if (!payload?.project) {
        throw new Error('创建成功但未返回项目信息');
      }
      onCreated(payload.project);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }, [displayName, onCreated, projectType]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-project-create-title"
        className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <h2 id="system-project-create-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          创建项目
        </h2>
        <p className="mt-1 text-[13px] text-neutral-500 dark:text-neutral-400">
          项目类型创建后不可更改。战创伤医学将使用专用伤情推演工作台。
        </p>

        <label className="mt-4 block text-[12px] font-medium text-neutral-700 dark:text-neutral-300">
          项目名称
          <input
            autoFocus
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !submitting) void handleSubmit();
            }}
            placeholder="例如：急诊科病例讨论"
            className="mt-1.5 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-[13px] text-neutral-900 outline-none focus:border-neutral-400 dark:border-neutral-600 dark:bg-neutral-950 dark:text-neutral-100"
          />
        </label>

        <div className="mt-4">
          <p className="text-[12px] font-medium text-neutral-700 dark:text-neutral-300">项目类型</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {SYSTEM_PROJECT_TYPES.map((type) => {
              const selected = type.id === projectType;
              return (
                <button
                  key={type.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setProjectType(type.id)}
                  disabled={submitting}
                  className={`rounded-md border px-3 py-2 text-left text-[13px] transition ${
                    selected
                      ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                      : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800'
                  }`}
                >
                  <span className="block font-medium">{type.label}</span>
                  <span className={`mt-0.5 block text-[11px] ${
                    selected ? 'text-neutral-300 dark:text-neutral-600' : 'text-neutral-500 dark:text-neutral-400'
                  }`}
                  >
                    {type.id === 'war_trauma' ? '连续伤情推演与分级救治' : '临床问答与病例分析'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {error ? (
          <p className="mt-3 text-[12px] text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          {onOpenLegacyPathWizard ? (
            <button
              type="button"
              className="text-[12px] text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
              onClick={() => {
                onClose();
                onOpenLegacyPathWizard();
              }}
              disabled={submitting}
            >
              从本地路径添加（旧）
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-[13px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              onClick={onClose}
              disabled={submitting}
            >
              取消
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
              onClick={() => void handleSubmit()}
              disabled={submitting}
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              创建
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
