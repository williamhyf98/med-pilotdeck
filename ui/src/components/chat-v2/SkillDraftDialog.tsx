import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import { cn } from '../../lib/utils.js';

/**
 * Confirmation dialog for the composer's "generate skill from conversation"
 * button. Mounting it immediately asks `/api/skills/generate-from-session`
 * for an LLM draft of the current session, then lets the user edit every
 * field (and regenerate wholesale) before the draft is persisted through the
 * existing `/api/skills/create` route — so validation, slug-conflict 409s and
 * the user-scope `reloadExtensions` all behave exactly like the Skills page.
 *
 * The flow editor reuses the whole dialog by passing `generateOverride`,
 * which replaces only the draft request; editing/creation stays identical.
 */

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

export type SkillDraft = {
  name: string;
  slug: string;
  description: string;
  body: string;
};

type SkillDraftDialogProps = {
  /** Chat session to read; required unless `generateOverride` is provided. */
  sessionId?: string;
  /** Chat-pipeline project path (fullPath ?? path); resolves the transcript. */
  projectPath?: string | null;
  /**
   * Replaces the session-based draft request (flow editor entry). Must be
   * referentially stable while the dialog is open — a new identity re-runs
   * generation.
   */
  generateOverride?: () => Promise<{ draft: SkillDraft }>;
  /** Null for the general project — collapses scope choice to `user`. */
  effectiveProjectPath: string | null;
  onClose: () => void;
  onCreated: (skill: { slug: string; name: string; scope: 'user' | 'project' }) => void;
};

async function api<T>(url: string, body: unknown): Promise<T> {
  const r = await authenticatedFetch(url, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = (data as { error?: string; message?: string }).error ||
      (data as { message?: string }).message || `Request failed (${r.status})`;
    const err = new Error(message) as Error & { code?: string };
    err.code = (data as { code?: string }).code;
    throw err;
  }
  return data as T;
}

export default function SkillDraftDialog({
  sessionId,
  projectPath,
  generateOverride,
  effectiveProjectPath,
  onClose,
  onCreated,
}: SkillDraftDialogProps) {
  const { t } = useTranslation('chat');
  const canUseProjectScope = Boolean(effectiveProjectPath);

  const [phase, setPhase] = useState<'generating' | 'editing' | 'submitting'>('generating');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  // Kept as code+message so the render pass can localise known codes.
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);

  // Drops responses from superseded/unmounted generate calls.
  const requestSeq = useRef(0);

  const generate = useCallback(async () => {
    const seq = ++requestSeq.current;
    setPhase('generating');
    setError(null);
    try {
      const result = generateOverride
        ? await generateOverride()
        : await api<{ draft: SkillDraft }>('/api/skills/generate-from-session', {
            sessionId,
            projectPath,
          });
      if (seq !== requestSeq.current) return;
      setSlug(result.draft.slug || '');
      setName(result.draft.name || '');
      setDescription(result.draft.description || '');
      setBody(result.draft.body || '');
      setPhase('editing');
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError({ code: (e as Error & { code?: string }).code, message: (e as Error).message });
      setPhase('editing');
    }
  }, [sessionId, projectPath, generateOverride]);

  useEffect(() => {
    void generate();
    return () => {
      requestSeq.current += 1;
    };
  }, [generate]);

  const trimmedSlug = slug.trim();
  const slugValid = SLUG_RE.test(trimmedSlug);
  const busy = phase === 'generating' || phase === 'submitting';
  const canSubmit = phase === 'editing' && slugValid && description.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setPhase('submitting');
    setError(null);
    const finalScope = canUseProjectScope ? scope : 'user';
    try {
      await api('/api/skills/create', {
        slug: trimmedSlug,
        name: name.trim() || trimmedSlug,
        description: description.trim(),
        body: body.trim(),
        scope: finalScope,
        projectPath: effectiveProjectPath,
      });
      onCreated({ slug: trimmedSlug, name: name.trim() || trimmedSlug, scope: finalScope });
    } catch (e) {
      setError({ code: (e as Error & { code?: string }).code, message: (e as Error).message });
      setPhase('editing');
    }
  };

  const errorText = error
    ? error.code === 'conversation_too_short'
      ? (t('skillDraft.tooShort', { defaultValue: '当前对话内容太少，无法生成技能' }) as string)
      : error.code === 'flow_too_simple'
        ? (t('skillDraft.flowTooSimple', { defaultValue: '流程图内容太少，无法生成技能：至少需要两个填写了文字的节点' }) as string)
        : error.message
    : null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-neutral-900/40 p-4 dark:bg-black/60"
      onClick={(event) => {
        if (event.target === event.currentTarget && phase !== 'submitting') onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && phase !== 'submitting') onClose();
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            <Sparkles className="h-4 w-4" strokeWidth={1.75} />
            {t('skillDraft.title', { defaultValue: '从对话生成技能' })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={phase === 'submitting'}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-900"
            aria-label={t('skillDraft.cancel', { defaultValue: '取消' }) as string}
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        {phase === 'generating' ? (
          <div className="flex min-h-[220px] flex-1 flex-col items-center justify-center gap-3 px-4 py-8">
            <Loader2 className="h-6 w-6 animate-spin text-neutral-400" strokeWidth={1.75} />
            <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
              {t('skillDraft.generating', { defaultValue: '正在阅读对话并起草技能…' })}
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {errorText ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
                {errorText}
              </p>
            ) : null}

            <Field label={t('skillDraft.name', { defaultValue: '名称' }) as string}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[13px] text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
            </Field>

            <Field
              label={t('skillDraft.slug', { defaultValue: '目录名（slug）' }) as string}
              hint={t('skillDraft.slugHint', { defaultValue: '字母或数字开头，可含 . _ -；创建后不可改' }) as string}
            >
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                disabled={busy}
                className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-[13px] text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
              {trimmedSlug && !slugValid ? (
                <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">
                  {t('skillDraft.slugInvalid', { defaultValue: 'slug 只能使用字母、数字、点、下划线和连字符，且须以字母或数字开头' })}
                </span>
              ) : null}
            </Field>

            <Field
              label={t('skillDraft.description', { defaultValue: '描述' }) as string}
              hint={t('skillDraft.descriptionHint', { defaultValue: '写清「什么时候该用这个技能」；模型靠这句话决定是否加载' }) as string}
            >
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                disabled={busy}
                className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[13px] text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
            </Field>

            <Field label={t('skillDraft.body', { defaultValue: '正文' }) as string}>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                disabled={busy}
                className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-[12px] text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
            </Field>

            {canUseProjectScope ? (
              <div>
                <span className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
                  {t('skillDraft.scope', { defaultValue: '归属' })}
                </span>
                <div className="flex gap-2">
                  {([
                    { value: 'user' as const, label: t('skillDraft.scopeUser', { defaultValue: '个人（所有项目可用）' }) as string },
                    { value: 'project' as const, label: t('skillDraft.scopeProject', { defaultValue: '本项目' }) as string },
                  ]).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      disabled={busy}
                      onClick={() => setScope(option.value)}
                      className={cn(
                        'h-7 rounded-md border px-2.5 text-[12px] transition disabled:opacity-60',
                        scope === option.value
                          ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                          : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', phase === 'generating' && 'animate-spin')} strokeWidth={1.75} />
            {t('skillDraft.regenerate', { defaultValue: '重新生成' })}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={phase === 'submitting'}
              className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              {t('skillDraft.cancel', { defaultValue: '取消' })}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {phase === 'submitting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : null}
              <span>
                {phase === 'submitting'
                  ? t('skillDraft.creating', { defaultValue: '创建中…' })
                  : t('skillDraft.create', { defaultValue: '创建技能' })}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11px] text-neutral-500 dark:text-neutral-400">{hint}</span>
      ) : null}
    </label>
  );
}
