import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { GitFork, MessageSquareText, Plus, Sparkles, Trash2, Workflow, X } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { authenticatedFetch } from '../../utils/api';
import { cn } from '../../lib/utils.js';
import SkillDraftDialog, { type SkillDraft } from '../chat-v2/SkillDraftDialog';
import SkillFlowChatPanel, { type FlowChatMessage } from './SkillFlowChatPanel';

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
 *
 * A collapsible side chat (SkillFlowChatPanel) offers a third input mode:
 * describe or amend the workflow in natural language and the canvas updates
 * live. Chat and manual editing compose freely — every chat turn snapshots
 * the current canvas, and the returned graph keeps the positions of nodes
 * whose ids survive.
 */

type FlowNodeData = { text: string };
type FlowNode = Node<FlowNodeData, 'step' | 'decision'>;

export type FlowDraftPayload = {
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

function toFlowPayload(nodes: FlowNode[], edges: Edge[]): FlowDraftPayload {
  return {
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
  };
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
  const [chatOpen, setChatOpen] = useState(true);
  const [chatMessages, setChatMessages] = useState<FlowChatMessage[]>([]);
  // Live mirrors so the chat panel's stable getFlow callback reads fresh state.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const rfInstance = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null);

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
    setDraftFlow(toFlowPayload(nodes, edges));
  }, [nodes, edges, flashNotice, t]);

  const getFlowSnapshot = useCallback(
    () => toFlowPayload(nodesRef.current, edgesRef.current),
    [],
  );

  /**
   * Replace the canvas with the graph a chat turn returned. Nodes whose id
   * survives keep their position (and their exact text when the model merely
   * echoed it back); new nodes are laid out under their first positioned
   * parent with the same offsets addNode uses, so chat-grown flows look like
   * hand-grown ones. Edges carry no user state beyond endpoints + branch, so
   * they are regenerated wholesale.
   */
  const applyChatFlow = useCallback((incoming: FlowDraftPayload) => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const positions = new Map<string, { x: number; y: number }>();
      for (const n of incoming.nodes) {
        const existing = prevById.get(n.id);
        if (existing) positions.set(n.id, existing.position);
      }
      const parentsByTarget = new Map<string, Array<{ source: string; handle: string | null }>>();
      for (const e of incoming.edges) {
        const list = parentsByTarget.get(e.target) ?? [];
        list.push({ source: e.source, handle: e.sourceHandle });
        parentsByTarget.set(e.target, list);
      }
      const pending = incoming.nodes.filter((n) => !positions.has(n.id));
      // Seed parentless new nodes (graph roots) so a from-scratch generation
      // lays out top-down instead of falling through to the orphan grid.
      if (pending.length > 0) {
        const hasParent = new Set(incoming.edges.map((e) => e.target));
        const seedY = positions.size === 0
          ? 80
          : Math.max(...[...positions.values()].map((p) => p.y)) + 180;
        let seedIndex = 0;
        for (const node of pending) {
          if (hasParent.has(node.id)) continue;
          positions.set(node.id, { x: 260 + seedIndex * 300, y: seedY });
          seedIndex += 1;
        }
        if (seedIndex > 0) {
          for (let i = pending.length - 1; i >= 0; i -= 1) {
            if (positions.has(pending[i].id)) pending.splice(i, 1);
          }
        }
      }
      const fanOut = new Map<string, number>();
      // Multi-pass so chains of brand-new nodes settle one level per pass.
      for (let pass = 0; pending.length > 0 && pass <= incoming.nodes.length; pass += 1) {
        let placed = false;
        for (let i = 0; i < pending.length; i += 1) {
          const node = pending[i];
          const parent = (parentsByTarget.get(node.id) ?? []).find((p) => positions.has(p.source));
          if (!parent) continue;
          const parentPos = positions.get(parent.source);
          if (!parentPos) continue;
          const parentHeight = prevById.get(parent.source)?.measured?.height ?? 110;
          const fanKey = `${parent.source} ${parent.handle ?? ''}`;
          const fan = fanOut.get(fanKey) ?? 0;
          fanOut.set(fanKey, fan + 1);
          positions.set(node.id, {
            x: (parent.handle === 'yes'
              ? parentPos.x - 150
              : parent.handle === 'no'
                ? parentPos.x + 150
                : parentPos.x) + fan * 40,
            y: parentPos.y + parentHeight + 70 + fan * 24,
          });
          pending.splice(i, 1);
          i -= 1;
          placed = true;
        }
        if (!placed) break;
      }
      if (pending.length > 0) {
        // Orphans (no positioned ancestor at all): park them in rows below.
        const maxY = Math.max(80, ...[...positions.values()].map((p) => p.y));
        pending.forEach((node, index) => {
          positions.set(node.id, {
            x: 260 + (index % 3) * 280,
            y: maxY + 180 + Math.floor(index / 3) * 170,
          });
        });
      }
      return incoming.nodes.map((n) => {
        const existing = prevById.get(n.id);
        const text = existing && existing.data.text.trim() === n.text.trim()
          ? existing.data.text
          : n.text;
        return {
          id: n.id,
          type: n.kind,
          position: positions.get(n.id) ?? { x: 260, y: 80 },
          data: { text },
          selected: false,
        };
      });
    });
    setEdges(incoming.edges.map((e, index) => ({
      id: `chat-e${index}-${e.source}-${e.sourceHandle ?? 'out'}-${e.target}`,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: null,
      ...EDGE_DEFAULTS,
      label: branchLabel(e.sourceHandle),
    })));
    // Keep manual "add node" ids collision-free after chat-created ids.
    let nextSeq = idSeq.current;
    for (const n of incoming.nodes) {
      const match = /(\d+)$/u.exec(n.id);
      if (match) nextSeq = Math.max(nextSeq, Number.parseInt(match[1], 10) + 1);
    }
    idSeq.current = nextSeq;
    window.setTimeout(() => {
      rfInstance.current?.fitView({ maxZoom: 1, duration: 300 });
    }, 60);
  }, [setNodes, setEdges]);

  const generateOverride = useCallback(async () => {
    return api<{ draft: SkillDraft }>('/api/skills/generate-from-flow', {
      flow: draftFlow,
      projectPath,
    });
  }, [draftFlow, projectPath]);

  const handleClose = useCallback(() => {
    const hasContent = nodes.some((n) => n.data.text.trim()) || chatMessages.length > 0;
    if (hasContent && !window.confirm(
      t('skillsTab.flowDiscardConfirm', { defaultValue: '关闭后当前流程图不会保存，确定关闭？' }) as string,
    )) {
      return;
    }
    onClose();
  }, [nodes, chatMessages, onClose, t]);

  // Portaled to <body>: the main area's content wrapper is a `z-0` stacking
  // context below the app header (z-[80]), so a fixed overlay rendered in
  // place can never cover the header regardless of its own z-index.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-white dark:bg-neutral-950">
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
            onClick={() => setChatOpen((open) => !open)}
            aria-pressed={chatOpen}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] transition',
              chatOpen
                ? 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300'
                : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900',
            )}
          >
            <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t('skillsTab.flowChatToggle', { defaultValue: 'AI 对话' })}</span>
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

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={(instance) => {
              rfInstance.current = instance;
            }}
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
        <SkillFlowChatPanel
          open={chatOpen}
          projectPath={projectPath}
          messages={chatMessages}
          setMessages={setChatMessages}
          getFlow={getFlowSnapshot}
          onApplyFlow={applyChatFlow}
          onClose={() => setChatOpen(false)}
        />
      </div>

      {draftFlow ? (
        <SkillDraftDialog
          generateOverride={generateOverride}
          effectiveProjectPath={effectiveProjectPath}
          onClose={() => setDraftFlow(null)}
          onCreated={onCreated}
        />
      ) : null}
    </div>,
    document.body,
  );
}
