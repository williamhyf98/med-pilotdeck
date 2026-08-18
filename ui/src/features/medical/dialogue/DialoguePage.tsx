import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Inbox,
  MessageSquarePlus,
  Pencil,
  Settings2,
  Square,
  Stethoscope,
  Trash2,
} from 'lucide-react';
import type { ChatInterfaceProps } from '../../../components/chat/types/types';
import ChatInterfaceV2 from '../../../components/chat-v2/ChatInterfaceV2';
import { cn } from '../../../lib/utils.js';
import {
  sessionDisplayTitle,
  setSessionCustomTitle,
  useCustomNamesVersion,
} from '../../../lib/customNames';
import type { Project, ProjectSession } from '../../../types/app';
import { getSessionRequestParams } from '../../../types/app';
import { api } from '../../../utils/api';
import {
  MEDICAL_TASK_MODES,
} from '../shared/constants';
import { MedicalCapabilityDrawer } from '../shared/MedicalControls';
import { fetchMedicalPresetInfo } from '../shared/medicalApi';
import type { MedicalPresetInfo } from '../shared/types';
import type {
  MedicalCapabilityId,
  MedicalTaskModeId,
} from '../shared/types';
import { useMedicalModels } from '../shared/useMedicalModels';
import AttachmentManager from './AttachmentManager';
import './DialoguePage.css';
import DialogueSettingsPanel from './DialogueSettingsPanel';
import {
  buildManagedContext,
  loadCorpora,
  loadDialogueCapabilities,
  samplingToTurnOverrides,
} from './dialogueApi';
import {
  DEFAULT_CAPABILITIES,
  MANAGED_PROMPTS,
  type DialogueCorpus,
  type ManagedPromptId,
  type PreparedAttachment,
  type SamplingSettings,
} from './dialogueTypes';

export type DialoguePageProps = {
  chatProps: ChatInterfaceProps;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  processingSessions: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession?: (
    project: Project,
    sessionId: string,
    fallbackSession?: ProjectSession,
    options?: { preserveActiveTab?: boolean },
  ) => void;
  onStartNewSession: (
    project: Project,
    options?: { preserveActiveTab?: boolean },
  ) => void;
  onOpenTrauma: () => void;
};

type DialogueTheme = 'military' | 'field' | 'dark';

const DIALOGUE_THEME_STORAGE_KEY = 'pilotdeck:medical-dialogue-theme';
const DIALOGUE_THEMES: Array<{ id: DialogueTheme; label: string; compact: string }> = [
  { id: 'military', label: '军绿', compact: '◐' },
  { id: 'field', label: '战地', compact: '◒' },
  { id: 'dark', label: '指挥台', compact: '◑' },
];

function initialTheme(): DialogueTheme {
  if (typeof window === 'undefined') return 'military';
  const stored = window.localStorage.getItem(DIALOGUE_THEME_STORAGE_KEY);
  if (stored === 'military' || stored === 'field' || stored === 'dark') return stored;
  return document.documentElement.classList.contains('dark') ? 'dark' : 'military';
}

function asTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatSessionTime(session: ProjectSession): string {
  const timestamp = Math.max(
    asTimestamp(session.lastActivity),
    asTimestamp(session.updated_at),
    asTimestamp(session.createdAt),
    asTimestamp(session.created_at),
  );
  if (!timestamp) return '历史会话';
  const diffMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  if (diffMinutes < 1_440) return `${Math.floor(diffMinutes / 60)} 小时前`;
  return `${Math.floor(diffMinutes / 1_440)} 天前`;
}

function sessionTitle(session: ProjectSession): string {
  return sessionDisplayTitle(session) || '未命名会话';
}

function composerPlaceholder(taskModeId: MedicalTaskModeId, dialogueName?: string | null): string {
  if (taskModeId === 'report-interpretation') {
    return '描述症状或上传影像、报告截图，进行结构化解读';
  }
  if (taskModeId === 'medicine-package-recognition') {
    return '上传药盒或说明书照片，识别药品并查看用药要点';
  }
  if (taskModeId === 'deep-search') {
    return '提问，将检索医学资料证据并回指来源';
  }
  if (taskModeId === 'table-digitization') {
    return '上传表格图片或文档，提取为可编辑结构化表格';
  }
  return `问一问${dialogueName ?? '九格医学辅助对话助手'}`;
}

export default function DialoguePage({
  chatProps,
  selectedProject,
  selectedSession,
  processingSessions,
  unreadSessionIds,
  onSelectSession,
  onStartNewSession,
  onOpenTrauma,
}: DialoguePageProps) {
  const [branding, setBranding] = useState<MedicalPresetInfo | null>(null);
  const [theme, setTheme] = useState<DialogueTheme>(initialTheme);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 1_120,
  );

  useEffect(() => {
    let cancelled = false;
    fetchMedicalPresetInfo().then((info) => {
      if (!cancelled) setBranding(info);
    }).catch(() => {
      // Use hardcoded fallback on fetch failure.
    });
    return () => { cancelled = true; };
  }, []);
  const [taskModeId, setTaskModeId] = useState<MedicalTaskModeId>('war-trauma-diagnosis');
  const sessionQuery = '';
  const [ragEnabled, setRagEnabled] = useState(false);
  const [thinkEnabled, setThinkEnabled] = useState(false);
  const [thinkingSuppressed, setThinkingSuppressed] = useState(false);
  const [capability, setCapability] = useState<MedicalCapabilityId | null>(null);
  const [capabilities, setCapabilities] = useState(DEFAULT_CAPABILITIES);
  const [corpora, setCorpora] = useState<DialogueCorpus[]>([]);
  const [selectedCorpusIds, setSelectedCorpusIds] = useState<string[]>([]);
  const [ragTopK, setRagTopK] = useState(5);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptId, setPromptId] = useState<ManagedPromptId>('clinical-safe');
  const [customPrompt, setCustomPrompt] = useState('');
  const [sampling, setSampling] = useState<SamplingSettings>({
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 4096,
  });
  const [attachments, setAttachments] = useState<PreparedAttachment[]>([]);
  const [composerFiles, setComposerFiles] = useState<File[]>([]);
  const [hiddenSessionIds, setHiddenSessionIds] = useState<Set<string>>(new Set());
  const [sessionActionError, setSessionActionError] = useState('');
  const {
    options,
    selectedModel,
    setSelectedModel,
    isLoading: modelsLoading,
  } = useMedicalModels();
  useCustomNamesVersion();

  useEffect(() => {
    window.localStorage.setItem(DIALOGUE_THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const syncSidebar = () => setSidebarCollapsed(window.innerWidth < 1_120);
    window.addEventListener('resize', syncSidebar);
    return () => window.removeEventListener('resize', syncSidebar);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadDialogueCapabilities().then(async (next) => {
      if (cancelled) return;
      setCapabilities(next);
      if (!next.rag) {
        setRagEnabled(false);
        setCorpora([]);
        return;
      }
      try {
        const nextCorpora = await loadCorpora();
        if (!cancelled) {
          setCorpora(nextCorpora);
          setSelectedCorpusIds(nextCorpora.filter((item) => item.ready).map((item) => item.id));
        }
      } catch {
        if (!cancelled) setCorpora([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const taskMode =
    MEDICAL_TASK_MODES.find((mode) => mode.id === taskModeId) ?? MEDICAL_TASK_MODES[0];
  const sessions = useMemo(() => {
    const query = sessionQuery.trim().toLocaleLowerCase();
    return [...(selectedProject?.sessions ?? [])]
      .sort((left, right) => (
        Math.max(asTimestamp(right.lastActivity), asTimestamp(right.updated_at))
        - Math.max(asTimestamp(left.lastActivity), asTimestamp(left.updated_at))
      ))
      .filter((session) => !hiddenSessionIds.has(session.id))
      .filter((session) => !query || sessionTitle(session).toLocaleLowerCase().includes(query));
  }, [hiddenSessionIds, selectedProject?.sessions, sessionQuery]);

  const commandPrefix = useMemo(() => buildManagedContext({
    taskLabel: taskMode.label,
    taskHint: taskMode.commandHint,
    prompt: MANAGED_PROMPTS.find((prompt) => prompt.id === promptId) ?? MANAGED_PROMPTS[0],
    customPrompt,
    ragEnabled,
    selectedCorpora: corpora.filter((item) => selectedCorpusIds.includes(item.id)),
    ragTopK,
    preparedAttachments: attachments,
  }), [
    attachments,
    corpora,
    customPrompt,
    promptId,
    ragEnabled,
    ragTopK,
    selectedCorpusIds,
    taskMode,
  ]);

  const profileId = taskModeId === 'report-interpretation'
    ? 'medical-report'
    : taskModeId === 'war-trauma-diagnosis'
      ? 'war-trauma-assessment'
      : taskModeId === 'deep-search' || ragEnabled
        ? 'medical-deep-search'
        : 'medical-general';

  const focusComposer = () => {
    const composer = document.querySelector<HTMLTextAreaElement>(
      '[data-chat-composer-slot] textarea',
    );
    composer?.focus();
  };

  const startNewSession = () => {
    if (selectedProject) {
      onStartNewSession(selectedProject, { preserveActiveTab: true });
      requestAnimationFrame(focusComposer);
    }
  };

  const renameSession = async (session: ProjectSession) => {
    const nextTitle = window.prompt('重命名会话', sessionTitle(session))?.trim();
    if (!nextTitle || nextTitle === sessionTitle(session)) return;
    setSessionActionError('');
    try {
      const response = await api.renameSession(session.id, nextTitle, 'pilotdeck');
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || `重命名失败（HTTP ${response.status}）`);
      }
      setSessionCustomTitle(session.id, nextTitle);
      await window.refreshProjects?.();
    } catch (cause) {
      setSessionActionError(cause instanceof Error ? cause.message : '重命名失败。');
    }
  };

  const deleteSession = async (session: ProjectSession) => {
    if (
      !selectedProject
      || !window.confirm(`确认删除会话“${sessionTitle(session)}”？此操作不可撤销。`)
    ) {
      return;
    }
    setSessionActionError('');
    try {
      const response = await api.deleteSession(
        selectedProject.name,
        session.id,
        getSessionRequestParams(session),
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || `删除失败（HTTP ${response.status}）`);
      }
      setSessionCustomTitle(session.id, null);
      setHiddenSessionIds((current) => new Set(current).add(session.id));
      await window.refreshProjects?.();
      if (selectedSession?.id === session.id) {
        onStartNewSession(selectedProject, { preserveActiveTab: true });
      }
    } catch (cause) {
      setSessionActionError(cause instanceof Error ? cause.message : '删除失败。');
    }
  };

  const generationActive = Boolean(
    selectedSession?.id && processingSessions.has(selectedSession.id),
  );
  const stopGeneration = () => {
    if (!selectedSession?.id || !generationActive) return;
    chatProps.sendMessage({
      type: 'abort-session',
      sessionId: selectedSession.id,
      provider: 'pilotdeck',
    });
  };

  const taskTabs = (
    <div className="medical-task-tabs" aria-label="医疗任务模式">
      <label className="medical-task-tab is-active" title={taskMode.description}>
        <span className="medical-task-tab-dot" aria-hidden="true" />
        <select
          aria-label="选择医疗任务模式"
          value={taskModeId}
          onChange={(event) => setTaskModeId(event.target.value as MedicalTaskModeId)}
        >
          {MEDICAL_TASK_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>{mode.label}</option>
          ))}
        </select>
        {taskModeId === 'deep-search' ? <span className="medical-task-rag-badge">RAG</span> : null}
      </label>
    </div>
  );

  const composerStart = (
    <AttachmentManager
      composerTrigger
      available={capabilities.attachments}
      reason={capabilities.reasons.attachments}
      items={attachments}
      onChange={setAttachments}
      onUseInComposer={setComposerFiles}
    />
  );

  const composerEnd = (
    <div className="medical-composer-primary-controls">
      <label className="medical-model-select">
        <span className="sr-only">选择模型</span>
        <select
          value={selectedModel}
          disabled={modelsLoading}
          aria-label="选择模型"
          onChange={(event) => setSelectedModel(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value || 'pilotdeck-route'} value={option.value}>
              {option.value ? option.label : 'G9-V-Med'}
            </option>
          ))}
        </select>
        <ChevronRight aria-hidden="true" />
      </label>
      <span className={cn('medical-model-status', modelsLoading && 'is-loading')}>
        {modelsLoading ? '加载中' : '✓ 已就绪'}
      </span>
      {generationActive ? (
        <button
          type="button"
          className="medical-stop-button"
          title="停止生成"
          aria-label="停止生成"
          onClick={stopGeneration}
        >
          <Square />
        </button>
      ) : null}
    </div>
  );

  return createPortal(
    <div
      data-testid="medical-dialogue-page"
      data-theme={theme}
      data-sidebar-collapsed={sidebarCollapsed ? 'true' : 'false'}
      className="medical-dialogue-shell fixed inset-0 z-[60] flex min-h-0 w-full overflow-hidden"
    >
      <aside className="medical-dialogue-sidebar">
        <div className="medical-sidebar-brand">
          <div className="medical-when-expanded min-w-0">
            <div className="medical-sidebar-title">{branding?.branding?.dialogueName ?? '九格医学对话助手'}</div>
            <div className="medical-sidebar-subtitle">医学辅助对话</div>
          </div>
          <button
            type="button"
            className="medical-sidebar-collapse"
            aria-label={sidebarCollapsed ? '展开菜单' : '收起菜单'}
            title={sidebarCollapsed ? '展开菜单' : '收起菜单'}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? <ChevronRight /> : <ChevronLeft />}
          </button>
        </div>

        <button
          type="button"
          className="medical-new-chat"
          disabled={!selectedProject}
          onClick={startNewSession}
          title="新对话"
        >
          <MessageSquarePlus />
          <span className="medical-when-expanded">新对话</span>
        </button>

        <div className="medical-sidebar-section-label medical-when-expanded">工作入口</div>
        <nav className="medical-work-entries" aria-label="医疗工作入口">
          <button
            type="button"
            className="medical-nav-button is-primary"
            title="创伤辅助救治助手"
            onClick={onOpenTrauma}
          >
            <Stethoscope />
            <span className="medical-when-expanded">创伤辅助救治助手</span>
          </button>
          <button
            type="button"
            className="medical-nav-button"
            title="系统配置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 />
            <span className="medical-when-expanded">系统配置</span>
          </button>
        </nav>

        <div className="medical-session-region medical-when-expanded">
          <div className="medical-sidebar-section-label">精选示例</div>
          <div className="medical-session-list">
            {sessions.length > 0 ? sessions.map((session) => {
              const active = selectedSession?.id === session.id;
              const processing = processingSessions.has(session.id);
              const unread = unreadSessionIds.has(session.id);
              return (
                <article
                  key={session.id}
                  className={cn('medical-session-item', active && 'is-active')}
                >
                  <button
                    type="button"
                    className="medical-session-open"
                    onClick={() => {
                      if (selectedProject && onSelectSession) {
                        onSelectSession(selectedProject, session.id, session, {
                          preserveActiveTab: true,
                        });
                      }
                    }}
                  >
                    <span className="medical-session-title-row">
                      <span className={cn(
                        'medical-session-dot',
                        processing ? 'is-processing' : unread ? 'is-unread' : '',
                      )} />
                      <span className="medical-session-title">{sessionTitle(session)}</span>
                    </span>
                    <span className="medical-session-time">
                      <Clock3 />
                      {processing ? '正在生成' : formatSessionTime(session)}
                    </span>
                  </button>
                  <div className="medical-session-actions">
                    <button
                      type="button"
                      aria-label="重命名会话"
                      title="重命名"
                      onClick={() => void renameSession(session)}
                    >
                      <Pencil />
                    </button>
                    <button
                      type="button"
                      aria-label="删除会话"
                      title="删除"
                      onClick={() => void deleteSession(session)}
                    >
                      <Trash2 />
                    </button>
                  </div>
                </article>
              );
            }) : (
              <div className="medical-session-empty">
                <Inbox aria-hidden="true" />
                <span>{sessionQuery ? '没有匹配的会话' : 'No data'}</span>
              </div>
            )}
          </div>
          {sessionActionError ? (
            <div className="medical-session-error">{sessionActionError}</div>
          ) : null}
        </div>

        <div className="medical-sidebar-spacer" />
        <footer className="medical-sidebar-footer">
          <div className="medical-sidebar-section-label medical-when-expanded">界面风格</div>
          <div className="medical-theme-options">
            {DIALOGUE_THEMES.map((option) => (
              <button
                key={option.id}
                type="button"
                className={cn('medical-theme-button', theme === option.id && 'is-active')}
                title={option.label}
                aria-pressed={theme === option.id}
                onClick={() => setTheme(option.id)}
              >
                <span className="medical-when-expanded">{option.label}</span>
                <span className="medical-when-collapsed">{option.compact}</span>
              </button>
            ))}
          </div>
        </footer>
      </aside>

      <main className="medical-dialogue-main">
        {!selectedProject ? (
          <div className="medical-project-warning">
            请先选择项目，医疗会话将复用该项目的 Gateway 与会话记录。
          </div>
        ) : null}
        {ragEnabled ? (
          <div className="medical-rag-notice">
            检索来源：
            {corpora
              .filter((item) => selectedCorpusIds.includes(item.id))
              .map((item) => item.name)
              .join('、') || '全部可用语料'}
            {' · '}Top-K {ragTopK}
          </div>
        ) : null}
        <div className="medical-dialogue-chat">
          <ChatInterfaceV2
            {...chatProps}
            modelOverride={selectedModel || undefined}
            profileOverride={profileId}
            thinkingModeOverride={thinkEnabled ? 'medium' : 'off'}
            showThinking={chatProps.showThinking !== false && !thinkingSuppressed}
            turnOverrides={samplingToTurnOverrides(sampling)}
            attachmentFilesOverride={composerFiles}
            onAttachmentFilesConsumed={() => setComposerFiles([])}
            commandPrefix={commandPrefix}
            composerPlaceholder={composerPlaceholder(taskModeId, branding?.branding?.dialogueName)}
            welcomeTitle={`您好，我是${branding?.branding?.dialogueName ?? '九格医学辅助对话助手'}`}
            welcomeDescription="可理解伤情描述与创面/医学影像，为您进行战创伤诊断，并支持从左侧进入其它工作台。"
            composerHeader={taskTabs}
            composerFooterStart={composerStart}
            composerFooterEnd={composerEnd}
            composerChrome="medical"
            forceWelcome={false}
            compact={false}
          />
        </div>
      </main>

      <MedicalCapabilityDrawer
        capability={capability}
        onClose={() => setCapability(null)}
        onUseTableMode={() => {
          setTaskModeId('table-digitization');
          setCapability(null);
          focusComposer();
        }}
      />
      <DialogueSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sampling={sampling}
        onSamplingChange={setSampling}
        promptId={promptId}
        onPromptIdChange={setPromptId}
        customPrompt={customPrompt}
        onCustomPromptChange={setCustomPrompt}
        ragAvailable={capabilities.rag}
        ragEnabled={ragEnabled}
        onRagEnabledChange={setRagEnabled}
        thinkEnabled={thinkEnabled}
        onThinkEnabledChange={(enabled) => {
          setThinkEnabled(enabled);
          setThinkingSuppressed(!enabled);
        }}
        corpora={corpora}
        selectedCorpusIds={selectedCorpusIds}
        onSelectedCorpusIdsChange={setSelectedCorpusIds}
        ragTopK={ragTopK}
        onRagTopKChange={setRagTopK}
        capabilities={capabilities}
        onOpenCapability={setCapability}
      />
    </div>,
    document.body,
  );
}
