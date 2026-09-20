import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { GitFork, Plus, Sparkles, Trash2, Workflow, X } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { authenticatedFetch } from '../../utils/api';
import { cn } from '../../lib/utils.js';
import SkillDraftDialog, { type SkillDraft } from '../chat-v2/SkillDraftDialog';

/**
 * Full-screen flowchart canvas for the Skills page's "create from flowchart"
 * entry. Users express a workflow as step/decision nodes plus arrows; the
 * graph is sent to `/api/skills/generate-from-flow`, which renders it to text
 * and reuses the same one-shot draft pipeline as the chat-based entry. The
 * confirmation/creation UI is the existing SkillDraftDialog, mounted with a
 * `generateOverride`, so editing, slug conflicts and scope behave identically.
 *
 * Interaction is deliberately minimal (the whole point is a lower bar than
 * writing SKILL.md by hand): "add step / add decision" buttons auto-connect
 * from the selected (or last) node, so a linear flow needs no manual wiring;
 * branches are drawn by dragging from a decision node's 是/否 handles.
 */

type FlowNodeData = { text: string };
type FlowNode = Node<FlowNodeData, 'step' | 'decision'>;

type FlowDraftPayload = {
  nodes: Array<{ id: string; kind: 'step' | 'decision'; text: string }>;
  edges: Array<{ source: string; target: string; sourceHandle: string | null }>;
};

type SkillFlowEditorProps = {
  /** Raw project path — resolves which project's model generates the draft. */
  projectPath: string | null;
  /** Null for the general project — collapses the scope choice to `user`. */
  effectiveProjectPath: string | null;
  onClose: () => void;
  onCreated: (skill: { slug: string; name: string; scope: 'user' | 'project' }) => void;
};

const FLOW_MIN_TEXT_NODES = 2;
const FLOW_MIN_TOTAL_CHARS = 20;
const EDGE_DEFAULTS = {
  markerEnd: { type: MarkerType.ArrowClosed },
  style: { strokeWidth: 1.5 },
} as const;

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

function branchLabel(sourceHandle: string | null | undefined): string | undefined {
  if (sourceHandle === 'yes') return '是';
  if (sourceHandle === 'no') return '否';
  return undefined;
}

/**
 * Shared card body for both node types. Text edits go through
 * `updateNodeData` and deletion through `deleteElements` — both emit changes
 * via onNodesChange, so the controlled state in the editor stays in sync.
 */
function FlowNodeCard({ id, kind, text, selected }: {
  id: string;
  kind: 'step' | 'decision';
  text: string;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const { updateNodeData, deleteElements } = useReactFlow();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow so multi-line steps stay fully visible without inner scrolling.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const isDecision = kind === 'decision';
  return (
    <div
      className={cn(
        'w-56 rounded-lg border bg-white shadow-sm transition-shadow dark:bg-neutral-900',
        isDecision
          ? 'border-amber-300 dark:border-amber-700/70'
          : 'border-neutral-300 dark:border-neutral-700',
        selected && 'shadow-md ring-2 ring-sky-400/70',
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !bg-neutral-400" />
      <div className="flex items-center justify-between px-2 pt-1.5">
        <span
          className={cn(
            'rounded px-1 py-px text-[10px] font-medium',
            isDecision
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
              : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
          )}
        >
          {isDecision
            ? t('skillsTab.flowDecisionLabel', { defaultValue: '判断' })
            : t('skillsTab.flowStepLabel', { defaultValue: '步骤' })}
        </span>
        <button
          type="button"
          onClick={() => void deleteElements({ nodes: [{ id }] })}
          className="nodrag inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          title={t('skillsTab.flowDeleteNode', { defaultValue: '删除节点' }) as string}
        >
          <Trash2 className="h-3 w-3" strokeWidth={1.75} />
        </button>
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => updateNodeData(id, { text: e.target.value })}
        rows={2}
        placeholder={
          (isDecision
            ? t('skillsTab.flowDecisionPlaceholder', { defaultValue: '判断条件，如：报告中有危急值？' })
            : t('skillsTab.flowStepPlaceholder', { defaultValue: '这一步做什么…' })) as string
        }
        className="nodrag block w-full resize-none overflow-hidden bg-transparent px-2 pb-2 pt-1 text-[12px] leading-5 text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
      />
      {isDecision ? (
        <>
          <div className="flex justify-between px-6 pb-1 text-[10px] text-neutral-400 dark:text-neutral-500">
            <span>{t('skillsTab.flowYes', { defaultValue: '是' })}</span>
            <span>{t('skillsTab.flowNo', { defaultValue: '否' })}</span>
          </div>
          <Handle
            type="source"
            id="yes"
            position={Position.Bottom}
            style={{ left: '25%' }}
            className="!h-2.5 !w-2.5 !bg-emerald-500"
          />
          <Handle
            type="source"
            id="no"
            position={Position.Bottom}
            style={{ left: '75%' }}
            className="!h-2.5 !w-2.5 !bg-rose-500"
          />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !bg-neutral-400" />
      )}
    </div>
  );
}

function StepNode({ id, data, selected }: NodeProps<FlowNode>) {
  return <FlowNodeCard id={id} kind="step" text={data.text} selected={Boolean(selected)} />;
}

function DecisionNode({ id, data, selected }: NodeProps<FlowNode>) {
  return <FlowNodeCard id={id} kind="decision" text={data.text} selected={Boolean(selected)} />;
}

// Must be referentially stable across renders — module scope, not inline.
const NODE_TYPES = { step: StepNode, decision: DecisionNode };

const INITIAL_NODES: FlowNode[] = [
  { id: 'n1', type: 'step', position: { x: 260, y: 80 }, data: { text: '' } },
];

export default function SkillFlowEditor({
  projectPath,
  effectiveProjectPath,
  onClose,
  onCreated,
}: SkillFlowEditorProps) {
  const { t } = useTranslation();
  const { isDarkMode } = useTheme() as { isDarkMode: boolean };

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const idSeq = useRef(2);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const [draftFlow, setDraftFlow] = useState<FlowDraftPayload | null>(null);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  const flashNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === connection.target) return;
    setEdges((eds) => addEdge(
      { ...connection, ...EDGE_DEFAULTS, label: branchLabel(connection.sourceHandle) },
      eds,
    ));
  }, [setEdges]);

  /**
   * Add a node below the anchor (single selected node, else the last one) and
   * auto-connect from the anchor's first free outlet, so building a linear
   * flow is just "click, type, click, type". Decision anchors hand out their
   * 是 outlet first, then 否; a fully wired anchor yields no edge.
   */
  const addNode = useCallback((kind: 'step' | 'decision') => {
    const id = `n${idSeq.current}`;
    idSeq.current += 1;
    const selectedNodes = nodes.filter((n) => n.selected);
    const anchor = selectedNodes.length === 1 ? selectedNodes[0] : nodes[nodes.length - 1];
    let position = { x: 260, y: 80 };
    if (anchor) {
      // undefined → anchor's default outlet is free; null → all outlets taken.
      let sourceHandle: string | null | undefined;
      if (anchor.type === 'decision') {
        const yesTaken = edges.some((e) => e.source === anchor.id && e.sourceHandle === 'yes');
        const noTaken = edges.some((e) => e.source === anchor.id && e.sourceHandle === 'no');
        sourceHandle = !yesTaken ? 'yes' : !noTaken ? 'no' : null;
      } else {
        sourceHandle = edges.some((e) => e.source === anchor.id) ? null : undefined;
      }
      const anchorHeight = anchor.measured?.height ?? 110;
      position = {
        x: sourceHandle === 'yes'
          ? anchor.position.x - 150
          : sourceHandle === 'no'
            ? anchor.position.x + 150
            : sourceHandle === null
              ? anchor.position.x + 60
              : anchor.position.x,
        y: anchor.position.y + anchorHeight + 70,
      };
      if (sourceHandle !== null) {
        setEdges((eds) => addEdge(
          {
            source: anchor.id,
            sourceHandle: sourceHandle ?? null,
            target: id,
            targetHandle: null,
            ...EDGE_DEFAULTS,
            label: branchLabel(sourceHandle),
          },
          eds,
        ));
      }
    }
    setNodes((nds) => [
      ...nds.map((n) => ({ ...n, selected: false })),
      { id, type: kind, position, data: { text: '' }, selected: true },
    ]);
  }, [nodes, edges, setNodes, setEdges]);

  const handleGenerate = useCallback(() => {
    const meaningful = nodes.filter((n) => n.data.text.trim());
    const totalChars = meaningful.reduce((sum, n) => sum + n.data.text.trim().length, 0);
    if (meaningful.length < FLOW_MIN_TEXT_NODES || totalChars < FLOW_MIN_TOTAL_CHARS) {
      flashNotice(t('skillsTab.flowTooSimple', {
        defaultValue: '流程图内容太少：至少需要两个填写了文字的节点',
      }) as string);
      return;
    }
    setDraftFlow({
      nodes: nodes.map((n) => ({
        id: n.id,
        kind: n.type === 'decision' ? 'decision' : 'step',
        text: n.data.text,
      })),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
      })),
    });
  }, [nodes, edges, flashNotice, t]);

  const generateOverride = useCallback(async () => {
    return api<{ draft: SkillDraft }>('/api/skills/generate-from-flow', {
      flow: draftFlow,
      projectPath,
    });
  }, [draftFlow, projectPath]);

  const handleClose = useCallback(() => {
    const hasContent = nodes.some((n) => n.data.text.trim());
    if (hasContent && !window.confirm(
      t('skillsTab.flowDiscardConfirm', { defaultValue: '关闭后当前流程图不会保存，确定关闭？' }) as string,
    )) {
      return;
    }
    onClose();
  }, [nodes, onClose, t]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-white dark:bg-neutral-950">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 px-3 dark:border-neutral-800">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="h-4 w-4 shrink-0 text-sky-500" strokeWidth={1.75} />
          <span className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
            {t('skillsTab.flowTitle', { defaultValue: '从流程图创建技能' })}
          </span>
          <span className="hidden truncate text-[11px] text-neutral-400 dark:text-neutral-500 md:block">
            {t('skillsTab.flowHint', { defaultValue: '添加节点并填写文字，拖动底部圆点到下一个节点可手动连线；选中节点后按 Delete 删除' })}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {notice ? (
            <span className="mr-1 text-[11px] text-red-600 dark:text-red-400">{notice}</span>
          ) : null}
          <button
            type="button"
            onClick={() => addNode('step')}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-neutral-300 px-2 text-[12px] text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t('skillsTab.flowAddStep', { defaultValue: '步骤' })}</span>
          </button>
          <button
            type="button"
            onClick={() => addNode('decision')}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 px-2 text-[12px] text-amber-800 transition hover:bg-amber-50 dark:border-amber-700/70 dark:text-amber-300 dark:hover:bg-amber-950/40"
          >
            <GitFork className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t('skillsTab.flowAddDecision', { defaultValue: '判断' })}</span>
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={Boolean(draftFlow)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t('skillsTab.flowGenerate', { defaultValue: '生成技能' })}</span>
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
            aria-label={t('skillsTab.close', { defaultValue: '关闭' }) as string}
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={NODE_TYPES}
          colorMode={isDarkMode ? 'dark' : 'light'}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
          deleteKeyCode={['Backspace', 'Delete']}
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {draftFlow ? (
        <SkillDraftDialog
          generateOverride={generateOverride}
          effectiveProjectPath={effectiveProjectPath}
          onClose={() => setDraftFlow(null)}
          onCreated={onCreated}
        />
      ) : null}
    </div>
  );
}
