import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
} from 'react';
import {
  ArrowUp,
  AtSign,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  CircleHelp,
  File,
  Folder,
  ListChecks,
  Loader2,
  Paperclip,
  FolderOpen,
  X,
  Sparkles,
  Square,
  type LucideIcon,
} from 'lucide-react';
import type { ChatRunMode, PendingPermissionRequest, PermissionMode } from '../chat/types/types';
import { MAX_ATTACHMENTS_ERROR_KEY, MEDICAL_FOLDER_WARNING_KEY } from '../chat/hooks/useChatComposerState';
import type { AttachedMedicalFolder } from '../chat/hooks/useChatComposerState';
import type { ThinkingModeId } from '../chat/constants/thinkingModes';
import type { ThinkingModeAvailability } from '../chat/constants/thinkingModeAvailability';
import PermissionRequestsBanner from '../chat/view/subcomponents/PermissionRequestsBanner';
import ImageAttachment from '../chat/view/subcomponents/ImageAttachment';
import CommandMenu from '../chat/view/subcomponents/CommandMenu';
import { cn } from '../../lib/utils.js';
import type { ContentReference } from '../../types/contentReference';
import type { MentionableFile, MentionedFile } from '../chat/hooks/useFileMentions';
import DocumentReferenceChip from './DocumentReferenceChip';
import MentionedFileChip from './MentionedFileChip';
import SkillRecommendBar from './SkillRecommendBar';
import { WORKSPACE_FILE_MENTION_DRAG_MIME } from '../../utils/workspaceFileMention';

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ComposerV2Props = {
  input: string;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onAbortSession: () => void;
  openImagePicker: () => void;
  openMedicalFolderPicker?: () => void;
  medicalFolderInputRef?: RefObject<HTMLInputElement | null>;
  onMedicalFolderInputChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  attachedMedicalFolders?: AttachedMedicalFolder[];
  onRemoveMedicalFolder?: (folderId: string) => void;
  documentReferences: ContentReference[];
  onRemoveDocumentReference: (id: string) => void;
  onOpenDocumentReference?: (filePath: string) => void;
  mentionedFiles: MentionedFile[];
  onRemoveMentionedFile: (relativePath: string) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;

  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  filteredFileTree: MentionableFile[];
  fileMentionQuery?: string;
  mentionProjectName?: string;
  expandedMentionDirectories?: Set<string>;
  onToggleMentionDirectory?: (path: string) => void;
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  onDropWorkspaceMention?: (dataTransfer: DataTransfer) => boolean;

  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];

  onToggleCommandMenu: () => void;
  onInsertMention: () => void;
  onInsertSlash: () => void;
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  isDragActive: boolean;

  isLoading: boolean;
  canAbortSession: boolean;
  isAbortPending?: boolean;
  isBusySendQueued?: boolean;
  isBusySendConfirmed?: boolean;
  onCancelBusySendQueue?: () => void;
  isSubmitPending?: boolean;
  tokenBudget?: Record<string, unknown> | null;
  thinkingMode: ThinkingModeId;
  thinkingModeAvailability: ThinkingModeAvailability;
  onThinkingModeChange: (mode: ThinkingModeId) => void;

  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: {
      allow?: boolean;
      message?: string;
      rememberEntry?: string | null;
      updatedInput?: unknown;
    },
  ) => void;
  handleGrantToolPermission: (suggestion: {
    entry: string;
    toolName: string;
  }) => { success: boolean };
  permissionMode: PermissionMode;
  runMode: ChatRunMode;
  onRunModeChange: (mode: ChatRunMode) => void;
  planModeAvailable?: boolean;
  onPlanExecutionApproved?: () => void;

  sendByCtrlEnter?: boolean;

  chromeless?: boolean;
  headerSlot?: ReactNode;
  footerStartSlot?: ReactNode;
  footerEndSlot?: ReactNode;
  chromeMode?: 'default' | 'medical';

  /**
   * Optional query→skill suggestions. Absent everywhere except the live chat
   * composer, so tests and the welcome-mode variants keep rendering without it.
   */
  skillRecommendProjectPath?: string | null;
  skillRecommendProjectType?: string | null;
  onInsertSkillHint?: (text: string) => void;

  /**
   * Turns the current conversation into a skill draft. Only the live chat
   * composer passes this, so the button stays hidden in welcome mode/tests.
   */
  onGenerateSkill?: () => void;
  generateSkillDisabled?: boolean;
};

function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function mentionNodeDragPayload(projectName: string, node: MentionableFile): string {
  return JSON.stringify({
    projectName,
    relativePath: node.path,
    kind: node.kind,
  });
}

function MentionFileTree({
  nodes,
  expandedPaths,
  onToggleDirectory,
  onSelectFile,
  onMentionDirectory,
  projectName,
  query,
  selectedFilePath,
}: {
  nodes: MentionableFile[];
  expandedPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (file: MentionableFile) => void;
  onMentionDirectory: (directory: MentionableFile) => void;
  projectName?: string;
  query: string;
  selectedFilePath?: string;
}) {
  const { t } = useTranslation('chat');
  const treeRef = useRef<HTMLDivElement>(null);
  const draggedNodeRef = useRef<MentionableFile | null>(null);
  useEffect(() => {
    if (!selectedFilePath) return;
    const selectedNode = treeRef.current?.querySelector('[data-selected="true"]');
    if (selectedNode && 'scrollIntoView' in selectedNode) {
      selectedNode.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedFilePath]);

  useEffect(() => {
    const handleDragOver = (event: globalThis.DragEvent) => {
      if (!draggedNodeRef.current) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const handleDrop = (event: globalThis.DragEvent) => {
      const draggedNode = draggedNodeRef.current;
      if (!draggedNode) return;
      draggedNodeRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      // The popup includes padding outside the tree rows; dropping anywhere in it cancels.
      const popup = treeRef.current?.parentElement;
      if (!popup?.contains(event.target as Node)) onSelectFile(draggedNode);
    };
    document.addEventListener('dragover', handleDragOver, true);
    document.addEventListener('drop', handleDrop, true);
    return () => {
      document.removeEventListener('dragover', handleDragOver, true);
      document.removeEventListener('drop', handleDrop, true);
    };
  }, [onSelectFile]);

  const renderNodes = (items: MentionableFile[], depth: number): ReactNode[] => items.map((node) => {
    const isDirectory = node.kind === 'directory';
    const isExpanded = isDirectory && (query.trim().length > 0 || expandedPaths.has(node.path));
    const children = node.children || [];
    const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
      if (!projectName) return;
      draggedNodeRef.current = node;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(
        WORKSPACE_FILE_MENTION_DRAG_MIME,
        mentionNodeDragPayload(projectName, node),
      );
      event.dataTransfer.setData('text/plain', node.path);
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (isDirectory) onToggleDirectory(node.path);
      else onSelectFile(node);
    };

    return (
      <div key={node.path}>
        <div
          role="treeitem"
          aria-expanded={isDirectory ? isExpanded : undefined}
          data-selected={!isDirectory && selectedFilePath === node.path ? 'true' : undefined}
          tabIndex={0}
          draggable={!isDirectory || depth > 0}
          onDragStart={handleDragStart}
          onDragEnd={() => { draggedNodeRef.current = null; }}
          onKeyDown={handleKeyDown}
          onClick={() => (isDirectory ? onToggleDirectory(node.path) : onSelectFile(node))}
          className={cn(
            'flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-left text-[12px] text-neutral-700 outline-none transition hover:bg-neutral-50 focus-visible:bg-neutral-100 focus-visible:ring-1 focus-visible:ring-neutral-300 dark:text-neutral-200 dark:hover:bg-neutral-800/70 dark:focus-visible:bg-neutral-800',
            !isDirectory && selectedFilePath === node.path && 'bg-neutral-100 dark:bg-neutral-800',
          )}
          style={{ paddingLeft: 8 + depth * 16 }}
          title={node.path}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-400">
            {isDirectory ? (
              <ChevronRight
                className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                strokeWidth={1.8}
              />
            ) : null}
          </span>
          {isDirectory ? (
            isExpanded
              ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" strokeWidth={1.8} />
              : <Folder className="h-4 w-4 shrink-0 text-amber-500" strokeWidth={1.8} />
          ) : (
            <File className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.8} />
          )}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {isDirectory && depth > 0 ? (
            <button
              type="button"
              draggable={false}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMentionDirectory(node);
              }}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
              title={t('input.mentionDirectory', { path: node.path, defaultValue: `Mention directory ${node.path}` }) as string}
              aria-label={t('input.mentionDirectory', { path: node.path, defaultValue: `Mention directory ${node.path}` }) as string}
            >
              <AtSign className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          ) : null}
        </div>
        {isDirectory && isExpanded && children.length > 0
          ? <div role="group">{renderNodes(children, depth + 1)}</div>
          : null}
        {isDirectory && isExpanded && node.truncated ? (
          <div
            className="py-1 text-[11px] text-neutral-500 dark:text-neutral-400"
            style={{ paddingLeft: 24 + depth * 16 }}
          >
            {t('input.truncatedDirectory', { defaultValue: 'Showing the first 500 items. View the full directory in the workspace.' })}
          </div>
        ) : null}
      </div>
    );
  });

  return <div role="tree" ref={treeRef}>{renderNodes(nodes, 0)}</div>;
}

export function PermissionRequestsSlot({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  onPlanExecutionApproved,
}: Pick<
  ComposerV2Props,
  | 'pendingPermissionRequests'
  | 'handlePermissionDecision'
  | 'handleGrantToolPermission'
  | 'onPlanExecutionApproved'
>) {
  if (pendingPermissionRequests.length === 0) return null;
  return (
    <div className="mb-3">
      <PermissionRequestsBanner
        pendingPermissionRequests={pendingPermissionRequests}
        handlePermissionDecision={handlePermissionDecision}
        handleGrantToolPermission={handleGrantToolPermission}
        onPlanExecutionApproved={onPlanExecutionApproved}
      />
    </div>
  );
}

type ContextStatus = {
  known: boolean;
  used: number;
  total: number;
  displayTotal: number;
  percent: number;
  percentLabel: string;
  usedLabel: string;
  totalLabel: string;
  state: 'ok' | 'warning' | 'blocking' | 'unknown';
  tone: 'normal' | 'amber' | 'red' | 'unknown';
};

type RunModeOption = {
  mode: ChatRunMode;
  Icon: LucideIcon;
  labelKey: string;
  defaultLabel: string;
};

const RUN_MODE_OPTIONS: RunModeOption[] = [
  {
    mode: 'agent',
    Icon: Bot,
    labelKey: 'input.runModes.agent',
    defaultLabel: 'Agent',
  },
  {
    mode: 'plan',
    Icon: ListChecks,
    labelKey: 'input.runModes.plan',
    defaultLabel: 'Plan',
  },
  {
    mode: 'ask',
    Icon: CircleHelp,
    labelKey: 'input.runModes.ask',
    defaultLabel: 'Ask',
  },
];

const BLOCKING_PERMISSION_TOOLS = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'ExitPlanModeV2',
  'exit_plan_mode',
]);

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
}

function formatContextPercentLabel(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) {
    return '0%';
  }
  if (percent > 100) {
    return '100%+';
  }
  return `${percent}%`;
}

export function getContextStatus(tokenBudget?: Record<string, unknown> | null): ContextStatus {
  const used = readNumber(tokenBudget?.displayUsed) ?? readNumber(tokenBudget?.used) ?? 0;
  const budgetUsed = readNumber(tokenBudget?.budgetUsed) ?? readNumber(tokenBudget?.used) ?? used;
  const total = readNumber(tokenBudget?.total) ?? 0;
  const effectiveTotal = readNumber(tokenBudget?.effectiveTotal);
  const displayTotal = effectiveTotal && effectiveTotal > 0 ? effectiveTotal : total;
  if (displayTotal <= 0) {
    return {
      known: false,
      used: 0,
      total: 0,
      displayTotal: 0,
      percent: 0,
      percentLabel: '0%',
      usedLabel: '--',
      totalLabel: '--',
      state: 'unknown',
      tone: 'unknown',
    };
  }

  // The visible count and percent must describe the same quantity. `budgetUsed`
  // includes the conservative request padding used by the compaction policy;
  // using it for the badge while showing `displayUsed` below produced confusing
  // combinations such as “100%+” beside “11,928 / 12,000”. Policy state still
  // uses the padded budget and can correctly remain blocking.
  const percent = Math.max(0, Math.round((used / displayTotal) * 100));
  const snapshotState = typeof tokenBudget?.state === 'string' ? tokenBudget.state : null;
  const tone = snapshotState === 'blocking'
    ? 'red'
    : snapshotState === 'warning'
      ? 'amber'
      : percent >= 95
        ? 'red'
        : percent >= 80
          ? 'amber'
          : 'normal';
  return {
    known: true,
    used,
    total,
    displayTotal,
    percent,
    percentLabel: formatContextPercentLabel(percent),
    usedLabel: formatTokenCount(used),
    totalLabel: formatTokenCount(displayTotal),
    state: snapshotState === 'blocking' || snapshotState === 'warning' ? snapshotState : 'ok',
    tone,
  };
}

export default function ComposerV2({
  input,
  placeholder,
  textareaRef,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaInput,
  onInputFocusChange,
  onSubmit,
  onAbortSession,
  openImagePicker,
  openMedicalFolderPicker,
  medicalFolderInputRef,
  onMedicalFolderInputChange,
  attachedImages,
  onRemoveImage,
  attachedMedicalFolders = [],
  onRemoveMedicalFolder,
  documentReferences,
  onRemoveDocumentReference,
  onOpenDocumentReference,
  mentionedFiles,
  onRemoveMentionedFile,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  filteredFileTree,
  fileMentionQuery = '',
  mentionProjectName,
  expandedMentionDirectories = new Set(['inbox', 'exports', 'export']),
  onToggleMentionDirectory,
  selectedFileIndex,
  onSelectFile,
  onDropWorkspaceMention,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  onToggleCommandMenu: _onToggleCommandMenu,
  onInsertMention,
  getRootProps,
  getInputProps,
  isDragActive,
  isLoading,
  canAbortSession,
  isAbortPending = false,
  isBusySendQueued = false,
  isBusySendConfirmed = false,
  onCancelBusySendQueue,
  isSubmitPending = false,
  tokenBudget,
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  runMode,
  onRunModeChange,
  planModeAvailable = true,
  onPlanExecutionApproved,
  chromeless = false,
  headerSlot,
  footerStartSlot,
  footerEndSlot,
  chromeMode = 'default',
  skillRecommendProjectPath = null,
  skillRecommendProjectType = null,
  onInsertSkillHint,
  onGenerateSkill,
  generateSkillDisabled = false,
}: ComposerV2Props) {
  const { t } = useTranslation('chat');
  const [isContextPopoverOpen, setIsContextPopoverOpen] = useState(false);
  const [isRunModeMenuOpen, setIsRunModeMenuOpen] = useState(false);
  const [expandedAttachedFolders, setExpandedAttachedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const attachmentPanelRef = useRef<HTMLDivElement>(null);

  const hasBlockingPermissionPanel = pendingPermissionRequests.some(
    (request) => BLOCKING_PERMISSION_TOOLS.has(request.toolName),
  );

  const hasDraftContent = input.trim().length > 0
    || attachedImages.length > 0
    || documentReferences.length > 0
    || mentionedFiles.length > 0
    || attachedMedicalFolders.some((folder) => folder.entries.length > 0);
  const hasUploadingImages = uploadingImages.size > 0;
  const attachmentLimitError = imageErrors.get(MAX_ATTACHMENTS_ERROR_KEY);
  const medicalFolderWarning = imageErrors.get(MEDICAL_FOLDER_WARNING_KEY);
  const filesInFolders = new Set(attachedMedicalFolders.flatMap(
    (folder) => folder.entries.map((entry) => entry.file),
  ));

  // Option B: after any attachment-area change, keep the panel scrolled to the
  // bottom so newly added chips / hard-fail red copy remain visible.
  useEffect(() => {
    const panel = attachmentPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [
    attachedImages,
    documentReferences,
    mentionedFiles,
    attachedMedicalFolders,
    attachmentLimitError,
    medicalFolderWarning,
  ]);

  const disabled = !hasDraftContent || isSubmitPending || hasUploadingImages;
  const showAbortButton = isLoading && canAbortSession && !hasDraftContent;
  const sendTitle = isSubmitPending || hasUploadingImages
    ? (t('input.sending', { defaultValue: 'Sending...' }) as string)
    : isBusySendConfirmed
      ? (t('input.queuedSendConfirmed', { defaultValue: 'Stopping current turn — sending next message' }) as string)
      : isBusySendQueued
        ? (t('input.queuedSendConfirm', { defaultValue: 'Queued — click send again to stop this turn and send now' }) as string)
      : isLoading
        ? (t('input.queueSend', { defaultValue: 'Queue message' }) as string)
        : (t('input.send', { defaultValue: 'Send' }) as string);
  const contextStatus = getContextStatus(tokenBudget);
  const selectedRunModeOption =
    RUN_MODE_OPTIONS.find((option) => option.mode === runMode) ||
    RUN_MODE_OPTIONS[0];
  const SelectedRunModeIcon = selectedRunModeOption.Icon;
  const selectedRunModeLabel = t(selectedRunModeOption.labelKey, {
    defaultValue: selectedRunModeOption.defaultLabel,
  }) as string;
  const contextStatusTitle = contextStatus.known
    ? (contextStatus.state === 'blocking'
        ? (t('input.contextStatusBlocking', {
            percentLabel: contextStatus.percentLabel,
            used: contextStatus.usedLabel,
            total: contextStatus.totalLabel,
            defaultValue:
              `${contextStatus.percentLabel} used. ${contextStatus.usedLabel} tokens used out of ${contextStatus.totalLabel}. Auto compact ran, but the context is still over the limit.`,
          }) as string)
        : (t('input.contextStatus', {
            percentLabel: contextStatus.percentLabel,
            used: contextStatus.usedLabel,
            total: contextStatus.totalLabel,
            defaultValue:
              `${contextStatus.percentLabel} used. ${contextStatus.usedLabel} tokens used out of ${contextStatus.totalLabel}. Auto compact runs near the limit.`,
          }) as string))
    : (t('input.contextStatusUnknown', {
      defaultValue: 'Context usage unknown. It will appear after the next model response.',
    }) as string);
  const contextWindowTitle = t('input.contextStatusTitle', { defaultValue: 'Context window' }) as string;
  const contextStatusUsedText = t('input.contextStatusUsed', {
    used: contextStatus.used.toLocaleString(),
    total: contextStatus.displayTotal.toLocaleString(),
    defaultValue: `${contextStatus.used.toLocaleString()} tokens used out of ${contextStatus.displayTotal.toLocaleString()}.`,
  }) as string;
  const contextStatusAutoCompactText = t('input.contextStatusAutoCompact', {
    defaultValue: 'Auto compact runs when the conversation approaches the configured limit.',
  }) as string;
  const contextStatusBlockingBodyText = t('input.contextStatusBlockingBody', {
    defaultValue: 'Compaction ran, but the context is still over the limit.',
  }) as string;
  const contextStatusUnknownBodyText = t('input.contextStatusUnknownBody', {
    defaultValue: 'No token budget has been reported yet. It will appear after the next model response.',
  }) as string;

  return (
    <div
      className={cn(
        'min-w-0 shrink-0',
        chromeless ? '' : 'workspace-dock-surface px-6 pb-6 pt-3',
      )}
    >
      <div className={cn('min-w-0', chromeless ? '' : 'mx-auto max-w-[720px]')}>
        <PermissionRequestsSlot
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          onPlanExecutionApproved={onPlanExecutionApproved}
        />

        {!hasBlockingPermissionPanel ? (
          <form
            onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
            onDragOverCapture={(event) => {
              if (!event.dataTransfer.types.includes(WORKSPACE_FILE_MENTION_DRAG_MIME)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDropCapture={(event) => {
              if (!event.dataTransfer.types.includes(WORKSPACE_FILE_MENTION_DRAG_MIME)) return;
              event.preventDefault();
              event.stopPropagation();
              onDropWorkspaceMention?.(event.dataTransfer);
            }}
            className={cn(
              'pd-composer-container relative',
              chromeMode === 'medical' && 'pd-composer--medical',
            )}
          >
            {attachedImages.length > 0 || documentReferences.length > 0 || mentionedFiles.length > 0 || attachedMedicalFolders.length > 0 || attachmentLimitError || medicalFolderWarning ? (
              <div
                ref={attachmentPanelRef}
                className="pd-composer-attachment-panel mb-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex flex-wrap gap-2">
                  {attachedMedicalFolders.map((folder) => {
                    const expanded = expandedAttachedFolders.has(folder.id);
                    const folderSize = folder.entries.reduce((sum, entry) => sum + entry.file.size, 0);
                    return (
                      <div
                        key={folder.id}
                        className="min-w-[220px] max-w-full rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[12px] text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setExpandedAttachedFolders((previous) => {
                              const next = new Set(previous);
                              if (next.has(folder.id)) next.delete(folder.id);
                              else next.add(folder.id);
                              return next;
                            })}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            aria-expanded={expanded}
                            title={expanded
                              ? (t('input.collapseFolder', { defaultValue: 'Collapse folder contents' }) as string)
                              : (t('input.expandFolder', { defaultValue: 'Expand folder contents' }) as string)}
                          >
                            <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                            <FolderOpen className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                            <span className="min-w-0 truncate">
                              {folder.rootName}
                              <span className="ml-1 text-emerald-700/80 dark:text-emerald-200/80">
                                ({t('input.folderFiles', {
                                  count: folder.entries.length,
                                  size: formatAttachmentSize(folderSize),
                                  defaultValue: `${folder.entries.length} files · ${formatAttachmentSize(folderSize)}`,
                                })})
                              </span>
                            </span>
                          </button>
                          {onRemoveMedicalFolder ? (
                            <button
                              type="button"
                              onClick={() => onRemoveMedicalFolder(folder.id)}
                              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-emerald-700 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
                              aria-label={t('input.removeMedicalFolder', { defaultValue: 'Remove folder' }) as string}
                            >
                              <X className="h-3.5 w-3.5" strokeWidth={2} />
                            </button>
                          ) : null}
                        </div>
                        {expanded ? (
                          <div className="mt-1.5 space-y-0.5 border-t border-emerald-200/70 pt-1.5 text-[11px] text-emerald-800/90 dark:border-emerald-900/60 dark:text-emerald-100/80">
                            {folder.entries.map((entry) => (
                              <div key={`${folder.id}:${entry.relativePath}`} className="truncate pl-6" title={entry.relativePath}>
                                {entry.relativePath}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {documentReferences.map((reference) => (
                    <DocumentReferenceChip
                      key={reference.id}
                      reference={reference}
                      className="pd-composer-reference-chip sm:max-w-[520px]"
                      removeLabel={t('documentReferences.remove', { defaultValue: 'Remove reference' }) as string}
                      openLabel={t('documentReferences.open', {
                        defaultValue: `Open ${reference.source.fileName}`,
                      }) as string}
                      onOpen={onOpenDocumentReference
                        ? () => onOpenDocumentReference(reference.source.relativePath)
                        : undefined}
                      onRemove={() => onRemoveDocumentReference(reference.id)}
                    />
                  ))}
                  {mentionedFiles.map((file) => (
                    <MentionedFileChip
                      key={file.relativePath}
                      name={file.name}
                      relativePath={file.relativePath}
                      kind={file.kind}
                      className="pd-composer-reference-chip sm:max-w-[520px]"
                      removeLabel={t('input.removeMention', { defaultValue: 'Remove file' }) as string}
                      onRemove={() => onRemoveMentionedFile(file.relativePath)}
                    />
                  ))}
                  {attachedImages.map((file, index) => (
                    filesInFolders.has(file)
                      ? null
                      : (
                        <ImageAttachment
                          key={index}
                          file={file}
                          onRemove={() => onRemoveImage(index)}
                          uploadProgress={uploadingImages.get(file.name)}
                          error={imageErrors.get(file.name)}
                        />
                      )
                  ))}
                </div>
                {attachmentLimitError ? (
                  <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                    {attachmentLimitError}
                  </div>
                ) : null}
                {medicalFolderWarning ? (
                  <div className="mt-2 text-xs text-amber-600 dark:text-amber-300">
                    {medicalFolderWarning}
                  </div>
                ) : null}
              </div>
            ) : null}

            {showFileDropdown && filteredFileTree.length > 0 ? (
              <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-72 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                <MentionFileTree
                  nodes={filteredFileTree}
                  expandedPaths={expandedMentionDirectories}
                  onToggleDirectory={onToggleMentionDirectory || (() => undefined)}
                  onSelectFile={onSelectFile}
                  onMentionDirectory={onSelectFile}
                  projectName={mentionProjectName}
                  query={fileMentionQuery}
                  selectedFilePath={selectedFileIndex >= 0 ? filteredFiles[selectedFileIndex]?.path : undefined}
                />
              </div>
            ) : null}

            <div
              {...getRootProps()}
              className={cn(
                'workspace-composer-surface group rounded-xl border p-2 transition-colors',
                'border-neutral-300/70 focus-within:border-neutral-400',
                'dark:border-neutral-700/80 dark:focus-within:border-neutral-600',
                isDragActive && 'border-dashed border-neutral-400 dark:border-neutral-500',
              )}
            >
              <input {...getInputProps()} />
              {headerSlot ? (
                <div className="pd-composer-header-slot">{headerSlot}</div>
              ) : null}

              <CommandMenu
                commands={filteredCommands}
                selectedIndex={selectedCommandIndex}
                onSelect={onCommandSelect}
                onClose={onCloseCommandMenu}
                isOpen={isCommandMenuOpen}
                frequentCommands={frequentCommands}
                position={(() => {
                  const ta = textareaRef?.current;
                  if (!ta) return { top: 0, left: 0, bottom: 90 };
                  const rect = ta.getBoundingClientRect();
                  return { top: rect.top - 8, left: rect.left, bottom: window.innerHeight - rect.top + 8 };
                })()}
              />

              {onInsertSkillHint ? (
                <SkillRecommendBar
                  input={input}
                  projectPath={skillRecommendProjectPath}
                  projectType={skillRecommendProjectType}
                  onUseSkill={onInsertSkillHint}
                  disabled={isCommandMenuOpen || showFileDropdown || isLoading}
                />
              ) : null}

              <textarea
                ref={textareaRef}
                value={input}
                onChange={onInputChange}
                onClick={onTextareaClick}
                onKeyDown={onTextareaKeyDown}
                onPaste={onTextareaPaste}
                onFocus={() => onInputFocusChange?.(true)}
                onBlur={() => onInputFocusChange?.(false)}
                onInput={onTextareaInput}
                placeholder={placeholder}
                rows={2}
                className="block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-2 pt-1.5 text-[14px] leading-6 text-neutral-900 placeholder-neutral-400 outline-none dark:text-neutral-100 dark:placeholder-neutral-500"
              />

                <div className="pd-composer-control-row flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-1">
                  <div className="pd-composer-toolbar-left flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
                    {footerStartSlot ? (
                      <div className="pd-composer-footer-start">{footerStartSlot}</div>
                    ) : null}
                    <div
                      className="relative mr-1"
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setIsRunModeMenuOpen(false);
                        }
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setIsRunModeMenuOpen((open) => !open)}
                        className={cn(
                          'pd-composer-icon-button inline-flex h-7 max-w-[108px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[140px]',
                          'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
                        )}
                        title={t('input.runModes.change', {
                          defaultValue: 'Select run mode',
                        }) as string}
                        aria-haspopup="menu"
                        aria-expanded={isRunModeMenuOpen}
                      >
                        <SelectedRunModeIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                        <span className="pd-composer-run-label truncate">{selectedRunModeLabel}</span>
                        <ChevronDown
                          className={cn(
                            'pd-composer-control-chevron h-3.5 w-3.5 shrink-0 transition-transform',
                            isRunModeMenuOpen && 'rotate-180',
                          )}
                          strokeWidth={2}
                        />
                      </button>
                      {isRunModeMenuOpen ? (
                        <div
                          role="menu"
                          className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
                        >
                          {RUN_MODE_OPTIONS.map((option) => {
                            const Icon = option.Icon;
                            const isSelected = runMode === option.mode;
                            const isPlan = option.mode === 'plan';
                            const isAsk = option.mode === 'ask';
                            const optionDisabled = isPlan && !planModeAvailable;
                            const label = t(option.labelKey, {
                              defaultValue: option.defaultLabel,
                            }) as string;
                            const description = isPlan
                              ? (t('input.runModes.planDescription', {
                                  defaultValue: 'Generate a plan first, then execute after confirmation',
                                }) as string)
                              : isAsk
                                ? (t('input.runModes.askDescription', {
                                    defaultValue: 'Only answers questions without modifying files',
                                  }) as string)
                              : (t('input.runModes.agentDescription', {
                                  defaultValue: 'Directly process and execute the task',
                                }) as string);

                            return (
                              <button
                                key={option.mode}
                                type="button"
                                role="menuitemradio"
                                aria-checked={isSelected}
                                disabled={optionDisabled}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  if (optionDisabled) return;
                                  onRunModeChange(option.mode);
                                  setIsRunModeMenuOpen(false);
                                }}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                                  isSelected
                                    ? 'bg-neutral-100 dark:bg-neutral-800'
                                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/70',
                                  optionDisabled && 'cursor-not-allowed opacity-45',
                                )}
                              >
                                <Icon
                                  className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400"
                                  strokeWidth={1.9}
                                />
                                <span className="min-w-0 flex-1">
                                  <span
                                    className={cn(
                                      'block truncate text-[13px]',
                                      isSelected
                                        ? 'font-bold text-neutral-900 dark:text-neutral-100'
                                        : 'font-medium text-neutral-700 dark:text-neutral-300',
                                    )}
                                  >
                                    {label}
                                  </span>
                                  <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                                    {optionDisabled
                                      ? t('input.runModes.planUnavailable', {
                                          defaultValue: 'Plan mode is only available for Anthropic models.',
                                        })
                                      : description}
                                  </span>
                                </span>
                                {isSelected ? (
                                  <Check className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-300" strokeWidth={2} />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={openImagePicker}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t('input.attachFiles', { defaultValue: 'Attach photos or files' }) as string}
                  >
                    <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  {openMedicalFolderPicker ? (
                    <button
                      type="button"
                      onClick={openMedicalFolderPicker}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                      title={t('input.attachMedicalFolder', {
                        defaultValue: 'Attach medical materials folder',
                      }) as string}
                    >
                      <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  ) : null}
                  {onMedicalFolderInputChange ? (
                    <input
                      ref={medicalFolderInputRef as RefObject<HTMLInputElement>}
                      type="file"
                      multiple
                      className="hidden"
                      // @ts-expect-error webkitdirectory is non-standard but widely supported
                      webkitdirectory=""
                      directory=""
                      onChange={onMedicalFolderInputChange}
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={onInsertMention}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t('input.mentionFile', { defaultValue: 'Mention a file' }) as string}
                  >
                    <AtSign className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  {onGenerateSkill ? (
                    <button
                      type="button"
                      onClick={onGenerateSkill}
                      disabled={generateSkillDisabled}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:disabled:hover:bg-transparent dark:disabled:hover:text-neutral-400"
                      title={t('input.generateSkill', {
                        defaultValue: 'Generate skill from conversation',
                      }) as string}
                    >
                      <Sparkles className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  ) : null}
                  </div>

                  {isBusySendQueued ? (
                    <div className="hidden min-w-0 flex-1 items-center justify-end gap-1 px-2 text-[12px] text-amber-700 dark:text-amber-300 sm:flex">
                      <span className="truncate rounded-full bg-amber-50 px-2 py-1 dark:bg-amber-950/30">
                        {isBusySendConfirmed
                          ? t('input.queuedSendConfirmedInline', { defaultValue: 'Stopping current turn; sending next' })
                          : t('input.queuedSendConfirmInline', { defaultValue: 'Queued; click again to stop this turn and send now' })}
                      </span>
                      <button
                        type="button"
                        onClick={onCancelBusySendQueue}
                        className="rounded-full px-2 py-1 text-amber-700 transition hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-950/50"
                        title={t('input.cancelQueuedSend', { defaultValue: 'Cancel queued message' }) as string}
                      >
                        {t('input.cancelQueuedSendShort', { defaultValue: 'Cancel' })}
                      </button>
                    </div>
                  ) : null}

                  <div className="pd-composer-toolbar-right ml-auto flex shrink-0 items-center gap-1">
                    {footerEndSlot ? (
                      <div className="pd-composer-footer-end">{footerEndSlot}</div>
                    ) : null}
                    <div
                      className="pd-composer-context-control relative"
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setIsContextPopoverOpen(false);
                        }
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setIsContextPopoverOpen((open) => !open)}
                        className={cn(
                          'pd-composer-icon-button inline-flex h-7 min-w-[44px] items-center justify-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums transition',
                          contextStatus.tone === 'red'
                            ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
                            : contextStatus.tone === 'amber'
                              ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'
                              : contextStatus.tone === 'normal'
                                ? 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                                : 'text-neutral-400 hover:bg-neutral-100 dark:text-neutral-500 dark:hover:bg-neutral-800',
                        )}
                        title={contextStatusTitle}
                        aria-label={contextStatusTitle}
                        aria-expanded={isContextPopoverOpen}
                      >
                        <CircleGauge className="h-4 w-4" strokeWidth={1.75} />
                        <span className="pd-composer-context-label">{contextStatus.known ? contextStatus.percentLabel : '--'}</span>
                      </button>
                      {isContextPopoverOpen ? (
                        <div
                          role="status"
                          className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-lg border border-neutral-200 bg-white p-3 text-left text-[12px] leading-5 text-neutral-700 shadow-lg dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="font-medium text-neutral-900 dark:text-neutral-100">
                              {contextWindowTitle}
                            </span>
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
                                contextStatus.tone === 'red'
                                  ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                                  : contextStatus.tone === 'amber'
                                    ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                                    : contextStatus.tone === 'normal'
                                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                              )}
                            >
                              {contextStatus.known ? contextStatus.percentLabel : '--'}
                            </span>
                          </div>
                          {contextStatus.known ? (
                            <>
                              <div className="text-neutral-500 dark:text-neutral-400">
                                {contextStatusUsedText}
                              </div>
                              <div className="mt-2 text-neutral-500 dark:text-neutral-400">
                                {contextStatusAutoCompactText}
                              </div>
                              {contextStatus.state === 'blocking' ? (
                                <div className="mt-2 text-red-600 dark:text-red-300">
                                  {contextStatusBlockingBodyText}
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <div className="text-neutral-500 dark:text-neutral-400">
                              {contextStatusUnknownBodyText}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>

                    {showAbortButton ? (
                      <button
                        type="button"
                        onClick={onAbortSession}
                        disabled={isAbortPending}
                        className={cn(
                          'inline-flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 text-white transition hover:bg-red-600',
                          isAbortPending && 'cursor-wait opacity-70 hover:bg-red-500',
                        )}
                        title={
                          isAbortPending
                            ? (t('input.stopping', { defaultValue: 'Stopping...' }) as string)
                            : (t('input.stop', { defaultValue: 'Stop' }) as string)
                        }
                      >
                        {isAbortPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                        ) : (
                          <Square className="h-3.5 w-3.5" strokeWidth={2.5} fill="currentColor" />
                        )}
                      </button>
                    ) : null}
                    <button
                      type="submit"
                      disabled={disabled}
                      aria-busy={isSubmitPending || hasUploadingImages || isBusySendConfirmed}
                      className={cn(
                        'inline-flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-white transition hover:opacity-90 disabled:opacity-40 dark:bg-neutral-50 dark:text-neutral-900',
                        isBusySendQueued && 'bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-400 dark:text-neutral-950 dark:hover:bg-amber-300',
                        isBusySendConfirmed && 'cursor-wait',
                        (isSubmitPending || hasUploadingImages) && 'cursor-wait',
                      )}
                      title={sendTitle}
                    >
                      {isSubmitPending || hasUploadingImages ? (
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                      ) : isBusySendConfirmed ? (
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                      ) : isBusySendQueued ? (
                        <Check className="h-4 w-4" strokeWidth={2.25} />
                      ) : (
                        <ArrowUp className="h-4 w-4" strokeWidth={2} />
                      )}
                    </button>
                  </div>
                </div>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
