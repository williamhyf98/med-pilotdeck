import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, PanelRightClose, Send, Workflow } from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import { cn } from '../../lib/utils.js';
import type { FlowDraftPayload } from './SkillFlowEditor';

/**
 * Side chat for the flow editor: the user describes (or amends) a workflow
 * in natural language and the canvas updates live. Each send posts the FULL
 * current graph plus the chat history to `/api/skills/flow-chat`; the server
 * returns a short reply and the complete updated graph, which the parent
 * applies back onto the canvas (keeping positions of surviving node ids).
 *
 * The panel is stateless about the graph on purpose — the canvas is the
 * single source of truth, so manual edits between chat turns are always
 * part of the next request and the two editing modes can't diverge.
 *
 * Kept mounted (parent hides it with CSS) so an in-flight request and the
 * transcript survive toggling the panel.
 */

export type FlowChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  /** Set on assistant turns that actually changed the canvas. */
  flowUpdated?: boolean;
};

type SkillFlowChatPanelProps = {
  open: boolean;
  /** Raw project path — resolves which project's model answers the chat. */
  projectPath: string | null;
  messages: FlowChatMessage[];
  setMessages: Dispatch<SetStateAction<FlowChatMessage[]>>;
  /** Snapshot of the canvas at send time (referentially stable). */
  getFlow: () => FlowDraftPayload;
  onApplyFlow: (flow: FlowDraftPayload) => void;
  onClose: () => void;
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

/** Order-insensitive equality, so a mere re-ordering doesn't count as an edit. */
function sameFlow(a: FlowDraftPayload, b: FlowDraftPayload): boolean {
  const nodeKeys = (f: FlowDraftPayload) =>
    f.nodes.map((n) => JSON.stringify([n.id, n.kind, n.text.trim()])).sort();
  const edgeKeys = (f: FlowDraftPayload) =>
    f.edges.map((e) => JSON.stringify([e.source, e.target, e.sourceHandle ?? ''])).sort();
  return (
    JSON.stringify(nodeKeys(a)) === JSON.stringify(nodeKeys(b)) &&
    JSON.stringify(edgeKeys(a)) === JSON.stringify(edgeKeys(b))
  );
}

export default function SkillFlowChatPanel({
  open,
  projectPath,
  messages,
  setMessages,
  getFlow,
  onApplyFlow,
  onClose,
}: SkillFlowChatPanelProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const aliveRef = useRef(true);

  useEffect(() => () => {
    aliveRef.current = false;
  }, []);

  // Keep the newest turn in view (also while the busy indicator shows).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // Auto-grow the composer like the node cards do, capped via max-h.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    const userMessage: FlowChatMessage = { role: 'user', text };
    const outgoing = [...messages, userMessage];
    setMessages(outgoing);
    setInput('');
    setBusy(true);
    setError(null);
    const flow = getFlow();
    try {
      const out = await api<{ reply: string; flow: FlowDraftPayload }>('/api/skills/flow-chat', {
        flow,
        messages: outgoing.map((m) => ({ role: m.role, text: m.text })),
        projectPath,
      });
      if (!aliveRef.current) return;
      const changed = !sameFlow(flow, out.flow);
      if (changed) onApplyFlow(out.flow);
      setMessages((prev) => [...prev, { role: 'assistant', text: out.reply, flowUpdated: changed }]);
    } catch (e) {
      if (!aliveRef.current) return;
      // Roll the optimistic user turn back into the composer for a clean retry.
      setMessages((prev) => (prev[prev.length - 1] === userMessage ? prev.slice(0, -1) : prev));
      setInput(text);
      setError((e as Error).message || (t('skillsTab.flowChatFailed', { defaultValue: '对话失败，请重试' }) as string));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [input, busy, messages, setMessages, getFlow, onApplyFlow, projectPath, t]);

  const examples = [
    t('skillsTab.flowChatExample1', { defaultValue: '帮我画一个「发热病人分诊」流程' }) as string,
    t('skillsTab.flowChatExample2', { defaultValue: '在当前流程里加一步医生复核' }) as string,
  ];

  return (
    <div
      className={cn(
        'flex w-80 shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950 md:w-96',
        !open && 'hidden',
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-200 px-3 dark:border-neutral-800">
        <span className="text-[12px] font-semibold text-neutral-900 dark:text-neutral-100">
          {t('skillsTab.flowChatTitle', { defaultValue: 'AI 对话' })}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
          aria-label={t('skillsTab.flowChatCollapse', { defaultValue: '收起对话' }) as string}
        >
          <PanelRightClose className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !busy ? (
          <div className="pt-6 text-center">
            <p className="text-[12px] font-medium text-neutral-600 dark:text-neutral-300">
              {t('skillsTab.flowChatEmptyTitle', { defaultValue: '用对话画流程图' })}
            </p>
            <p className="mx-auto mt-1 max-w-[260px] text-[11px] leading-5 text-neutral-400 dark:text-neutral-500">
              {t('skillsTab.flowChatEmptyHint', {
                defaultValue: '描述流程或提出修改，画布会实时更新；手动编辑随时可用，两边不冲突',
              })}
            </p>
            <div className="mt-3 flex flex-col items-center gap-1.5">
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setInput(example);
                    inputRef.current?.focus();
                  }}
                  className="rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message, index) => (
          <div
            key={index}
            className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[12px] leading-5',
                message.role === 'user'
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'bg-neutral-100 text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200',
              )}
            >
              {message.text}
              {message.flowUpdated ? (
                <span className="mt-1 flex items-center gap-1 text-[10px] text-sky-600 dark:text-sky-400">
                  <Workflow className="h-3 w-3" strokeWidth={1.75} />
                  {t('skillsTab.flowChatUpdated', { defaultValue: '已更新画布' })}
                </span>
              ) : null}
            </div>
          </div>
        ))}

        {busy ? (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[12px] text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              {t('skillsTab.flowChatBusy', { defaultValue: '正在更新流程图…' })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-800">
        {error ? (
          <p className="mb-1.5 px-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>
        ) : null}
        <div className="flex items-end gap-1.5">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            disabled={busy}
            placeholder={t('skillsTab.flowChatPlaceholder', {
              defaultValue: '描述流程，或让 AI 修改当前流程图…',
            }) as string}
            className="max-h-[120px] min-h-[32px] flex-1 resize-none overflow-y-auto rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] leading-5 text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || !input.trim()}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-900 text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            aria-label={t('skillsTab.flowChatSend', { defaultValue: '发送' }) as string}
          >
            {busy
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              : <Send className="h-3.5 w-3.5" strokeWidth={1.75} />}
          </button>
        </div>
      </div>
    </div>
  );
}
