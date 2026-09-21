import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Radio,
  type LucideIcon,
} from 'lucide-react';
import { resolveProjectType } from '../../app-shell/appShellSelection';
import ChatInterfaceV2 from '../../chat-v2/ChatInterfaceV2';
import TraumaWorkspace from '../../trauma-workspace/TraumaWorkspace';
import type { TurnFormInput, VitalItemKey } from '../../trauma-workspace/domain/types';
import { subStageLabel } from '../../trauma-workspace/domain/displayLabels';
import {
  createTemporarySessionId,
  isTemporarySessionId,
  startSessionCommand,
} from '../../chat/utils/sessionLauncher';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import { cn } from '../../../lib/utils.js';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import type { CodeEditorDiffInfo } from '../../code-editor/types/types';
import type {
  AlwaysOnSessionTarget,
  AppTab,
  Project,
  ProjectSession,
} from '../../../types/app';
import { api } from '../../../utils/api';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import ToolSidePanel from './subcomponents/ToolSidePanel';

const AlwaysOnV2 = React.lazy(() => import('../../main-content-v2/AlwaysOnV2'));
const CronV2 = React.lazy(() => import('../../main-content-v2/CronV2'));
const FilesV2 = React.lazy(() => import('../../main-content-v2/FilesV2'));
const ShellV2 = React.lazy(() => import('../../main-content-v2/ShellV2'));
const GitV2 = React.lazy(() => import('../../main-content-v2/GitV2'));
const DashboardV2 = React.lazy(() => import('../../main-content-v2/DashboardV2'));
const TasksV2 = React.lazy(() => import('../../main-content-v2/TasksV2'));
const MemoryPanel = React.lazy(() => import('./memory/MemoryPanel'));
const SkillsV2 = React.lazy(() => import('../../main-content-v2/SkillsV2'));
const StorageV2 = React.lazy(() => import('../../main-content-v2/StorageV2'));

function TabSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
    </div>
  );
}

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

type MainContentToast = { kind: 'error' | 'info'; text: string } | null;

const FILES_PANEL_WIDTH = 320;
const FILE_PREVIEW_WIDTH = 560;
const TOOL_PANEL_STORAGE_KEY = 'pilotdeck:dashboard-panel-width';
const TOOL_PANEL_DEFAULT_WIDTH = 480;
const TOOL_PANEL_MIN_WIDTH = 360;
const TOOL_PANEL_MAX_WIDTH = 720;
const TOOL_PANEL_MAX_LAYOUT_RATIO = 0.48;

type DashboardPanelTab = Extract<AppTab, 'dashboard' | 'always-on'>;

const DASHBOARD_PANEL_TABS = new Set<AppTab>(['dashboard', 'always-on']);
const DASHBOARD_PANEL_META: Record<DashboardPanelTab, { labelKey: string; icon: LucideIcon }> = {
  dashboard: { labelKey: 'tabs.dashboard', icon: BarChart3 },
  'always-on': { labelKey: 'tabs.alwaysOn', icon: Radio },
};

const TRAUMA_VITAL_LABELS: Record<VitalItemKey, { label: string; unit: string }> = {
  respiratoryRate: { label: '呼吸', unit: '次/分' },
  systolicBloodPressure: { label: '收缩压', unit: 'mmHg' },
  heartRate: { label: '心率', unit: '次/分' },
  temperature: { label: '体温', unit: '℃' },
};

function summarizeTraumaForm(form: TurnFormInput): string {
  const parts = [
    `救治级别：${form.statedSubStage ? subStageLabel(form.statedSubStage) : '由系统判定'}`,
    form.injuryNarrative ? `伤情：${form.injuryNarrative}` : null,
    form.treatmentNarrative ? `已做处置：${form.treatmentNarrative}` : null,
    form.evacuationNarrative ? `后送条件：${form.evacuationNarrative}` : null,
    form.note ? `补充说明：${form.note}` : null,
    Object.keys(form.vitals).length > 0
      ? `生命体征：${Object.entries(form.vitals)
        .map(([key, value]) => {
          const vital = TRAUMA_VITAL_LABELS[key as VitalItemKey];
          return `${vital.label} ${value} ${vital.unit}`;
        })
        .join('，')}`
      : null,
  ].filter((part): part is string => Boolean(part));
  return parts.map((part) => `- ${part}`).join('\n');
}

function readStoredToolPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(TOOL_PANEL_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : TOOL_PANEL_DEFAULT_WIDTH;
  } catch {
    return TOOL_PANEL_DEFAULT_WIDTH;
  }
}

async function readJsonPayload<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function createClientRunId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `client-run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function MainContent({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  alwaysOnSubTab = 'dashboard',
  onAlwaysOnSubTabChange,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onSessionActivityBump,
  processingSessions,
  unreadSessionIds,
  onReplaceTemporarySession,
  onNavigateToSession,
  onStartNewSession,
  onSelectSession,
  onShowSettings,
  onSelectProjectByName,
  onCreateProject,
  externalMessageUpdate,
  misroutedFileFromUrl,
  onMisroutedFileUrlHandled,
}: MainContentProps) {
  const { i18n } = useTranslation();
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, inlineThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const [toast, setToast] = useState<MainContentToast>(null);
  const [traumaSubmitting, setTraumaSubmitting] = useState(false);
  // Set to true the moment the user clicks stop so submitting=false fires
  // immediately, without waiting for external state (processingSessions,
  // traumaSubmitting) to propagate through parent re-renders.
  const [traumaLocallyAborted, setTraumaLocallyAborted] = useState(false);
  const [pendingTraumaRun, setPendingTraumaRun] = useState<{
    runId: string;
    mainStage?: string;
    subStage?: string;
    round?: number;
  } | null>(null);
  const navigateToChatMessageRef = useRef<((runId: string) => void | Promise<void>) | null>(null);
  const traumaAbortUIRef = useRef<(() => void) | null>(null);
  const traumaOptimisticMessageRef = useRef<(
    (text: string, targetSessionId?: string | null, runId?: string, traumaAttachments?: Array<{ name: string; path?: string; previewUrl?: string }>) => void
  ) | null>(null);

  const submitTraumaForm = useCallback((
    form: TurnFormInput,
    rawInput = '',
    traumaExtract = false,
    traumaAttachments: Array<{ path: string; name: string }> = [],
    preferredSessionId?: string,
  ) => {
    if (!selectedProject || traumaSubmitting) return;
    const selectedSessionId = selectedSession?.id;
    const concreteSessionId = preferredSessionId
      ?? (selectedSessionId && !isTemporarySessionId(selectedSessionId)
        ? selectedSessionId
        : undefined);
    const temporarySessionId = concreteSessionId
      ? undefined
      : selectedSessionId || createTemporarySessionId();
    const summary = summarizeTraumaForm(form);
    const runId = createClientRunId();
    const visibleInput = traumaExtract && rawInput.trim() ? rawInput.trim() : summary;
    setTraumaLocallyAborted(false);
    setTraumaSubmitting(true);
    try {
      // Keep the sidebar in sync with the generic chat flow: create/bump the
      // session row before the runner starts so a new trauma conversation is
      // visible while its answer is still streaming. A temporary id is
      // replaced in-place when the server emits session_created.
      if (selectedProject.name) {
        const optimisticSessionId = concreteSessionId
          ?? temporarySessionId
          ?? createTemporarySessionId();
        onSessionActivityBump?.(
          selectedProject.name,
          optimisticSessionId,
          visibleInput,
        );
      }
      traumaOptimisticMessageRef.current?.(visibleInput, concreteSessionId, runId, traumaAttachments);
      const activatedSessionId = startSessionCommand({
        sendMessage,
        selectedProject,
        command: `战创伤推演：${visibleInput}`,
        userVisibleInput: visibleInput,
        sessionId: concreteSessionId,
        temporarySessionId,
        sessionSummary: summary,
        runId,
        traumaForm: form,
        traumaRawInput: rawInput,
        traumaExtract,
        ...(traumaAttachments.length > 0 ? { traumaAttachments } : {}),
      });
      onSessionActive?.(activatedSessionId);
      if (concreteSessionId) onSessionProcessing?.(concreteSessionId);
      if (activatedSessionId && !isTemporarySessionId(activatedSessionId)) {
        onNavigateToSession?.(activatedSessionId);
      }
    } catch (error) {
      setTraumaSubmitting(false);
      throw error;
    }
  }, [
    onSessionActive,
    onSessionProcessing,
    selectedProject,
    selectedSession?.id,
    onSessionActivityBump,
    onNavigateToSession,
    sendMessage,
    traumaSubmitting,
  ]);

  const abortTraumaTurn = useCallback(() => {
    const pendingSessionId = typeof window !== 'undefined'
      ? window.sessionStorage.getItem('pendingSessionId')
      : null;
    const sessionId = [selectedSession?.id, pendingSessionId]
      .find((value) => Boolean(value) && !isTemporarySessionId(value));
    if (!sessionId) return;
    // Set the local abort flag first — this short-circuits the submitting prop
    // calculation immediately, before any external state (traumaSubmitting,
    // processingSessions) propagates through parent re-renders.
    setTraumaLocallyAborted(true);
    setTraumaSubmitting(false);
    setPendingTraumaRun(null);
    traumaAbortUIRef.current?.();
    sendMessage({
      type: 'abort-session',
      sessionId,
      provider: 'pilotdeck',
    });
  }, [selectedSession?.id, sendMessage]);

  const handleTraumaProcessStateChange = useCallback((state: {
    runId: string;
    state: 'snapshot_started' | 'turn_failed';
    mainStage?: string;
    subStage?: string;
    round?: number;
  }) => {
    setPendingTraumaRun((current) => {
      if (state.state !== 'snapshot_started') {
        return current?.runId === state.runId ? null : current;
      }
      // 同一轮里会收到多个 snapshot_started：第 5 步和第 10 步带确认后的级别，
      // 而正文写完时的「整理推演流程图/保存推演结果」标记不带。后者不能把已经
      // 定好的位置擦成空，否则「生成中」节点又会掉回默认子级。
      const sameRun = current?.runId === state.runId;
      const keepPlacement = sameRun && !state.subStage && Boolean(current?.subStage);
      return {
        runId: state.runId,
        mainStage: keepPlacement ? current?.mainStage : state.mainStage,
        subStage: keepPlacement ? current?.subStage : state.subStage,
        round: state.round ?? (sameRun ? current?.round : undefined),
      };
    });
  }, []);

  useEffect(() => {
    setTraumaSubmitting(false);
    setPendingTraumaRun(null);
  }, [selectedProject?.name, selectedSession?.id]);

  useEffect(() => {
    if (!traumaSubmitting) return undefined;
    const handleComplete = (event: Event) => {
      const detail = (event as CustomEvent<{ projectName?: string; projectPath?: string }>).detail;
      const projectKeys = [selectedProject?.name, selectedProject?.fullPath, selectedProject?.path]
        .filter(Boolean);
      const eventProjectKeys = [detail?.projectName, detail?.projectPath].filter(Boolean);
      if (eventProjectKeys.length > 0 && !eventProjectKeys.some((key) => projectKeys.includes(key))) return;
      setTraumaSubmitting(false);
    };
    window.addEventListener('pilotdeck:agent-turn-complete', handleComplete);
    return () => window.removeEventListener('pilotdeck:agent-turn-complete', handleComplete);
  }, [selectedProject, traumaSubmitting]);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  const {
    editorTabs,
    activeEditorTabId,
    activeFilePath,
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handlePreviewFileOpen,
    handleFileGoBack,
    handleTabSelect,
    handleTabClose,
    handleTabsClose,
    handleTabDirtyChange,
    handleFileRename,
    handleFileDelete,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  const openFileInWorkspace = useCallback((
    filePath: string,
    diffInfo: CodeEditorDiffInfo | null = null,
  ) => {
    handleFileOpen(filePath, diffInfo);
    setActiveTab('files');
  }, [handleFileOpen, setActiveTab]);

  const handledMisroutedFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (!misroutedFileFromUrl || !selectedProject) return;
    if (handledMisroutedFileRef.current === misroutedFileFromUrl) return;
    handledMisroutedFileRef.current = misroutedFileFromUrl;
    openFileInWorkspace(misroutedFileFromUrl);
    onMisroutedFileUrlHandled?.();
  }, [
    misroutedFileFromUrl,
    selectedProject,
    openFileInWorkspace,
    onMisroutedFileUrlHandled,
  ]);

  useEffect(() => {
    if (!misroutedFileFromUrl) {
      handledMisroutedFileRef.current = null;
    }
  }, [misroutedFileFromUrl]);

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  const refreshProjectsSilently = useCallback(() => {
    if (window.refreshProjects) {
      void window.refreshProjects();
    }
  }, []);

  const applyAndLaunchCycle = useCallback(async (
    projectName: string,
    cycleId: string,
  ) => {
    const response = await api.applyWorkCycle(projectName, cycleId);
    const payload = await readJsonPayload<{ cycle?: { id: string }; sessionKey?: string; executionToken?: string; error?: { code: string; message: string } | string }>(response);
    if (!response.ok || !payload) {
      const errMsg = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
      throw new Error(errMsg || 'Failed to queue discovery plan apply');
    }
    if (payload.error) {
      const errMsg = typeof payload.error === 'string' ? payload.error : payload.error.message;
      throw new Error(errMsg);
    }

    refreshProjectsSilently();
  }, [refreshProjectsSilently]);

  const flashToast = useCallback((toastValue: MainContentToast, ms = 2400) => {
    setToast(toastValue);
    if (toastValue) {
      window.setTimeout(() => setToast(null), ms);
    }
  }, []);

  const getProjectSessions = useCallback((project: Project): ProjectSession[] =>
    project.sessions ?? [],
  []);

  const findSessionInProject = useCallback((project: Project, sessionId: string) => (
    getProjectSessions(project).find((session) => session.id === sessionId)
  ), [getProjectSessions]);

  const loadPilotDeckSession = useCallback(async (projectName: string, sessionId: string) => {
    const response = await api.sessions(projectName, Number.MAX_SAFE_INTEGER, 0);
    if (!response.ok) {
      return null;
    }
    const payload = await readJsonPayload<{ sessions?: ProjectSession[] }>(response);
    return payload?.sessions?.find((session) => session.id === sessionId) ?? null;
  }, []);

  const handleOpenAlwaysOnSession = useCallback(async (target: AlwaysOnSessionTarget) => {
    if (!selectedProject) {
      return;
    }

    const missingMessage = i18n.t('alwaysOn:sessionMissing', {
      defaultValue: 'This chat record no longer exists.',
    });

    if (target.kind === 'origin') {
      const lookupProjectName = target.projectName || selectedProject.name;
      const targetProject =
        target.projectName && target.projectName !== selectedProject.name
          ? projects.find((p) => p.name === target.projectName) ?? selectedProject
          : selectedProject;

      const existingSession =
        findSessionInProject(targetProject, target.sessionId) ??
        await loadPilotDeckSession(lookupProjectName, target.sessionId);

      if (!existingSession) {
        flashToast({ kind: 'error', text: missingMessage });
        return;
      }

      const fallbackSession: ProjectSession = {
        ...existingSession,
        isReadOnly: true,
        __projectName: lookupProjectName,
      };

      setActiveTab('chat');
      if (onSelectSession) {
        onSelectSession(targetProject, target.sessionId, fallbackSession);
        return;
      }
      onNavigateToSession(target.sessionId);
      return;
    }

    const existingSession =
      findSessionInProject(selectedProject, target.sessionId) ??
      await loadPilotDeckSession(selectedProject.name, target.sessionId);

    if (!existingSession) {
      flashToast({ kind: 'error', text: missingMessage });
      return;
    }

    const fallbackSession: ProjectSession = {
      ...existingSession,
      id: target.sessionId,
      title: target.title || existingSession.title || existingSession.summary || target.summary,
      summary: target.summary || existingSession.summary || existingSession.title || target.title,
      lastActivity: target.lastActivity || existingSession.lastActivity,
      sessionKind: 'background_task',
      parentSessionId: target.parentSessionId,
      relativeTranscriptPath: target.relativeTranscriptPath,
      transcriptKey: target.transcriptKey || existingSession.transcriptKey,
      taskId: target.taskId || existingSession.taskId,
      taskStatus: target.taskStatus || existingSession.taskStatus,
      outputFile: target.outputFile || existingSession.outputFile,
      isReadOnly: true,
      __projectName: selectedProject.name,
    };

    setActiveTab('chat');
    if (onSelectSession) {
      onSelectSession(selectedProject, target.sessionId, fallbackSession);
      return;
    }
    onNavigateToSession(target.sessionId);
  }, [
    findSessionInProject,
    flashToast,
    i18n,
    loadPilotDeckSession,
    onNavigateToSession,
    onSelectSession,
    projects,
    selectedProject,
    setActiveTab,
  ]);

  const handleOpenExecutionSession = useCallback(
    (projectKey: string, runId: string, projectName?: string) => {
      const rawId = `always-on/execute:project=${projectKey}:run=${runId}`;
      const sessionId = rawId.replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
      void handleOpenAlwaysOnSession({ kind: 'origin', sessionId, projectName });
    },
    [handleOpenAlwaysOnSession],
  );

  if (isLoading) {
    return (
      <MainContentStateView
        mode="loading"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />
    );
  }

  if (
    !selectedProject
    && activeTab !== 'dashboard'
    && activeTab !== 'cron'
    && activeTab !== 'skills'
    && activeTab !== 'storage'
  ) {
    return (
      <MainContentStateView
        mode="empty"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onCreateProject={onCreateProject}
      />
    );
  }

  return (
    <div className="workspace-content-surface relative flex h-full min-h-0 flex-col text-neutral-900 dark:text-neutral-100">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SplitBody
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          shouldShowTasksTab={shouldShowTasksTab}
          tasksEnabled={tasksEnabled}
          setActiveTab={setActiveTab}
          alwaysOnSubTab={alwaysOnSubTab}
          onAlwaysOnSubTabChange={onAlwaysOnSubTabChange}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          handleFileOpen={openFileInWorkspace}
          onInputFocusChange={onInputFocusChange}
          onSessionActive={onSessionActive}
          onSessionInactive={onSessionInactive}
          onSessionProcessing={onSessionProcessing}
          onSessionNotProcessing={onSessionNotProcessing}
          onSessionActivityBump={onSessionActivityBump}
          processingSessions={processingSessions}
          submitTraumaForm={submitTraumaForm}
          abortTraumaTurn={abortTraumaTurn}
          traumaOptimisticMessageRef={traumaOptimisticMessageRef}
          navigateToChatMessageRef={navigateToChatMessageRef}
          traumaAbortUIRef={traumaAbortUIRef}
          traumaSubmitting={traumaSubmitting}
          traumaLocallyAborted={traumaLocallyAborted}
          pendingTraumaRun={pendingTraumaRun}
          onTraumaProcessStateChange={handleTraumaProcessStateChange}
          unreadSessionIds={unreadSessionIds}
          onReplaceTemporarySession={onReplaceTemporarySession}
          onNavigateToSession={onNavigateToSession}
          onStartNewSession={onStartNewSession}
          onSelectSession={onSelectSession}
          onShowSettings={onShowSettings}
          externalMessageUpdate={externalMessageUpdate}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          inlineThinking={inlineThinking}
          autoScrollToBottom={autoScrollToBottom}
          sendByCtrlEnter={sendByCtrlEnter}
          applyAndLaunchCycle={applyAndLaunchCycle}
          handleOpenExecutionSession={handleOpenExecutionSession}
          editorExpanded={editorExpanded}
          hasEditor={editingFile !== null}
          activeFilePath={activeFilePath}
          onFileRename={handleFileRename}
          onFileDelete={handleFileDelete}
          onSelectProjectByName={onSelectProjectByName}
          isMobile={isMobile}
          editorSidebarProps={{
            editorTabs,
            activeEditorTabId,
            isMobile,
            editorExpanded,
            editorWidth,
            hasManualWidth,
            resizeHandleRef,
            onResizeStart: handleResizeStart,
            onTabSelect: handleTabSelect,
            onTabClose: handleTabClose,
            onTabsClose: handleTabsClose,
            onTabDirtyChange: handleTabDirtyChange,
            onToggleEditorExpand: handleToggleEditorExpand,
            onPreviewFileOpen: handlePreviewFileOpen,
            onGoBack: handleFileGoBack,
            projectPath: selectedProject?.path,
          }}
        />
      </div>
      {toast ? (
        <div
          className={cn(
            'pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md px-3 py-1.5 text-[12px] shadow-lg',
            toast.kind === 'error' && 'bg-red-600 text-white',
            toast.kind === 'info' && 'bg-neutral-800 text-white',
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

// V2 split body: chat is the persistent primary surface, Files is a dedicated
// workbench, and auxiliary dashboards open in a resizable side panel.
type SplitBodyProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  shouldShowTasksTab: boolean;
  tasksEnabled: boolean;
  setActiveTab: (tab: any) => void;
  alwaysOnSubTab: MainContentProps['alwaysOnSubTab'];
  onAlwaysOnSubTabChange: MainContentProps['onAlwaysOnSubTabChange'];
  ws: any;
  sendMessage: any;
  latestMessage: any;
  handleFileOpen: (filePath: string, diffInfo?: CodeEditorDiffInfo | null) => void;
  onInputFocusChange: any;
  onSessionActive: any;
  onSessionInactive: any;
  onSessionProcessing: any;
  onSessionNotProcessing: any;
  onSessionActivityBump?: (
    projectName: string,
    sessionId: string,
    optimisticTitle?: string,
  ) => void;
  processingSessions: Set<string>;
  submitTraumaForm: (
    form: TurnFormInput,
    rawInput?: string,
    traumaExtract?: boolean,
    traumaAttachments?: Array<{ path: string; name: string; previewUrl?: string }>,
    sessionId?: string,
  ) => void;
  abortTraumaTurn: () => void;
  traumaOptimisticMessageRef: React.MutableRefObject<((text: string, targetSessionId?: string | null, runId?: string, traumaAttachments?: Array<{ name: string; path?: string; previewUrl?: string }>) => void) | null>;
  navigateToChatMessageRef: React.MutableRefObject<((runId: string) => void | Promise<void>) | null>;
  traumaAbortUIRef: React.MutableRefObject<(() => void) | null>;
  traumaSubmitting: boolean;
  traumaLocallyAborted: boolean;
  pendingTraumaRun: {
    runId: string;
    mainStage?: string;
    subStage?: string;
    round?: number;
  } | null;
  onTraumaProcessStateChange: (state: {
    runId: string;
    state: 'snapshot_started' | 'turn_failed';
    mainStage?: string;
    subStage?: string;
    round?: number;
  }) => void;
  unreadSessionIds: Set<string>;
  onReplaceTemporarySession: any;
  onNavigateToSession: (sessionId: string) => void;
  onStartNewSession: MainContentProps['onStartNewSession'];
  onSelectSession: MainContentProps['onSelectSession'];
  onShowSettings: any;
  externalMessageUpdate: any;
  autoExpandTools: any;
  showRawParameters: any;
  showThinking: any;
  inlineThinking: any;
  autoScrollToBottom: any;
  sendByCtrlEnter: any;
  applyAndLaunchCycle: (projectName: string, cycleId: string) => Promise<void>;
  handleOpenExecutionSession: (projectKey: string, runId: string, projectName?: string) => void;
  editorExpanded: boolean;
  hasEditor: boolean;
  activeFilePath: string | null;
  onFileRename: (oldPath: string, newPath: string) => void;
  onFileDelete: (deletedPath: string) => void;
  onSelectProjectByName?: (projectName: string) => void;
  isMobile: boolean;
  editorSidebarProps: React.ComponentProps<typeof EditorSidebar>;
};

function SplitBody(props: SplitBodyProps) {
  const { t } = useTranslation();
  const {
    selectedProject,
    selectedSession,
    activeTab,
    shouldShowTasksTab,
    tasksEnabled,
    setActiveTab,
    alwaysOnSubTab = 'dashboard',
    onAlwaysOnSubTabChange,
    ws,
    sendMessage,
    latestMessage,
    handleFileOpen,
    onInputFocusChange,
    onSessionActive,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onSessionActivityBump,
    processingSessions,
    submitTraumaForm,
    abortTraumaTurn,
    traumaOptimisticMessageRef,
    navigateToChatMessageRef,
    traumaAbortUIRef,
    traumaSubmitting,
    traumaLocallyAborted,
    pendingTraumaRun,
    onTraumaProcessStateChange,
    unreadSessionIds,
    onReplaceTemporarySession,
    onNavigateToSession,
    onStartNewSession,
    onSelectSession,
    onShowSettings,
    externalMessageUpdate,
    autoExpandTools,
    showRawParameters,
    showThinking,
    inlineThinking,
    autoScrollToBottom,
    sendByCtrlEnter,
    applyAndLaunchCycle,
    handleOpenExecutionSession,
    editorExpanded,
    hasEditor,
    activeFilePath,
    onFileRename,
    onFileDelete,
    onSelectProjectByName,
    isMobile,
    editorSidebarProps,
  } = props;

  // Shell, Git, Memory, Skills, Storage, Tasks, and plugin tabs use the full workspace.
  // Dashboard and Always-On remain auxiliary panels paired with chat.
  // Files stays a separate explorer + artifact + assistant mode.
  const isPlugin = typeof activeTab === 'string' && activeTab.startsWith('plugin:');
  const fullScreenToolTabs = new Set([
    'shell',
    'git',
    'cron',
    'memory',
    'skills',
    'storage',
    'tasks',
  ]);
  const isFullScreenTool = fullScreenToolTabs.has(activeTab) || isPlugin;
  const isDashboardPanel = DASHBOARD_PANEL_TABS.has(activeTab);
  const dashboardPanelTab = isDashboardPanel ? activeTab as DashboardPanelTab : null;
  // Tasks tab is conditional — fall back to chat if the project hasn't
  // enabled it yet so we don't render a black hole.
  const renderTasksAsTool = activeTab === 'tasks' && shouldShowTasksTab;
  const isFiles = activeTab === 'files';
  const filesSplitContainerRef = useRef<HTMLDivElement | null>(null);
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const [toolPanelWidth, setToolPanelWidth] = useState(readStoredToolPanelWidth);
  const [toolPanelResizing, setToolPanelResizing] = useState(false);
  const toolPanelMaxWidth = workbenchWidth > 0
    ? Math.max(
        TOOL_PANEL_MIN_WIDTH,
        Math.min(TOOL_PANEL_MAX_WIDTH, workbenchWidth * TOOL_PANEL_MAX_LAYOUT_RATIO),
      )
    : TOOL_PANEL_MAX_WIDTH;
  const filePreviewWidth = workbenchWidth > 0
    ? Math.min(FILE_PREVIEW_WIDTH, Math.max(380, workbenchWidth - FILES_PANEL_WIDTH - 420))
    : FILE_PREVIEW_WIDTH;

  useEffect(() => {
    const container = filesSplitContainerRef.current;
    if (!container) return undefined;

    const updateWidth = () => setWorkbenchWidth(container.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setToolPanelWidth((width) => Math.min(Math.max(width, TOOL_PANEL_MIN_WIDTH), toolPanelMaxWidth));
  }, [toolPanelMaxWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(TOOL_PANEL_STORAGE_KEY, String(Math.round(toolPanelWidth)));
    } catch {
      // The panel remains usable when localStorage is unavailable.
    }
  }, [toolPanelWidth]);

  const clampToolPanelWidth = useCallback((width: number) => (
    Math.min(Math.max(width, TOOL_PANEL_MIN_WIDTH), toolPanelMaxWidth)
  ), [toolPanelMaxWidth]);

  const handleToolPanelResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!dashboardPanelTab || isMobile) return;
    event.preventDefault();
    setToolPanelResizing(true);
  }, [dashboardPanelTab, isMobile]);

  const handleToolPanelResizeBy = useCallback((delta: number) => {
    setToolPanelWidth((width) => clampToolPanelWidth(width + delta));
  }, [clampToolPanelWidth]);

  useEffect(() => {
    if (!toolPanelResizing) return undefined;

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const container = filesSplitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setToolPanelWidth(clampToolPanelWidth(rect.right - event.clientX));
    };
    const handleMouseUp = () => setToolPanelResizing(false);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [clampToolPanelWidth, toolPanelResizing]);

  const renderTool = () => {
    if (activeTab === 'shell') {
      return (
        <ShellV2
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          isActive
        />
      );
    }
    if (activeTab === 'git') {
      return <GitV2 selectedProject={selectedProject} onFileOpen={handleFileOpen} />;
    }
    if (activeTab === 'always-on') {
      return (
        <AlwaysOnV2
          selectedProject={selectedProject}
          subTab={alwaysOnSubTab}
          onSubTabChange={onAlwaysOnSubTabChange ?? (() => undefined)}
          onApplyWorkCycle={applyAndLaunchCycle}
          onOpenExecutionSession={handleOpenExecutionSession}
          compact
        />
      );
    }
    if (activeTab === 'cron') return <CronV2 />;
    if (activeTab === 'dashboard') return <DashboardV2 projectFilter={selectedProject?.name} projectFullPath={selectedProject?.fullPath} onSelectProject={onSelectProjectByName} compact />;
    if (activeTab === 'memory') return <MemoryPanel selectedProject={selectedProject} selectedSession={selectedSession} />;
    if (activeTab === 'skills') return <SkillsV2 selectedProject={selectedProject} />;
    if (activeTab === 'storage') return <StorageV2 />;
    if (renderTasksAsTool) return <TasksV2 isVisible />;
    if (isPlugin) {
      return (
        <PluginTabContent
          pluginName={activeTab.replace('plugin:', '')}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
        />
      );
    }
    return null;
  };

  const showFullScreenTool = isFullScreenTool && (activeTab !== 'tasks' || shouldShowTasksTab);
  const showChat = !showFullScreenTool;
  const filePreviewExpanded = isFiles && showChat && hasEditor && editorExpanded;
  const isWarTraumaProject = selectedProject
    ? resolveProjectType(selectedProject) === 'war_trauma'
    : false;
  const chatInterface = (
    <ChatInterfaceV2
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      ws={ws}
      sendMessage={sendMessage}
      latestMessage={latestMessage}
      onFileOpen={handleFileOpen}
      onInputFocusChange={onInputFocusChange}
      onSessionActive={onSessionActive}
      onSessionInactive={onSessionInactive}
      onSessionProcessing={onSessionProcessing}
      onSessionNotProcessing={onSessionNotProcessing}
      onSessionActivityBump={onSessionActivityBump}
      processingSessions={processingSessions}
      onReplaceTemporarySession={onReplaceTemporarySession}
      onNavigateToSession={onNavigateToSession}
      onShowSettings={onShowSettings}
      autoExpandTools={autoExpandTools}
      showRawParameters={showRawParameters}
      showThinking={showThinking}
      inlineThinking={inlineThinking}
      autoScrollToBottom={autoScrollToBottom}
      sendByCtrlEnter={sendByCtrlEnter}
      externalMessageUpdate={externalMessageUpdate}
      onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
      forceWelcome={false}
      onExitWelcome={isFiles ? undefined : () => setActiveTab('chat')}
      compact={isFiles}
      hideComposer={isWarTraumaProject}
      traumaOptimisticMessageRef={traumaOptimisticMessageRef}
      navigateToChatMessageRef={navigateToChatMessageRef}
      traumaAbortUIRef={traumaAbortUIRef}
      onTraumaProcessStateChange={onTraumaProcessStateChange}
    />
  );
  return (
    <div
      ref={filesSplitContainerRef}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      {/* Legacy full-screen surfaces (Shell, Git, Tasks, plugin tabs). */}
      {showFullScreenTool && (
        <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
          <Suspense fallback={<TabSkeleton />}>
            {renderTool()}
          </Suspense>
        </div>
      )}

      {/* Conversation stays mounted while project files open beside it. */}
      <div
        key="agent-surface"
        className={cn(
          'workspace-chat-surface flex min-h-0 min-w-0 flex-1 flex-col',
          !showChat && 'invisible absolute h-0 w-0 overflow-hidden',
          filePreviewExpanded && 'invisible absolute h-0 w-0 overflow-hidden',
        )}
        aria-hidden={!showChat || filePreviewExpanded}
      >
        <ErrorBoundary showDetails>
          {isWarTraumaProject ? (
            <TraumaWorkspace
              resetKey={`${selectedProject?.name ?? ''}:${selectedSession?.id ?? ''}`}
              projectKey={selectedProject?.fullPath || selectedProject?.path || selectedProject?.name}
              sessionId={selectedSession?.id}
              onSubmitForm={submitTraumaForm}
              onAbortTurn={abortTraumaTurn}
              pendingRun={pendingTraumaRun}
              onNavigateToChatMessage={(runId) => navigateToChatMessageRef.current?.(runId)}
              runtimePanel={chatInterface}
              conversationOnly={isFiles}
              submitting={!traumaLocallyAborted && (traumaSubmitting || Boolean(
                selectedSession?.id && processingSessions.has(selectedSession.id)
              ))}
            />
          ) : chatInterface}
        </ErrorBoundary>
      </div>

      {isFiles && showChat && hasEditor && selectedProject ? (
        <aside
          className={cn(
            'animate-in slide-in-from-right z-20 h-full min-h-0 overflow-hidden border-l border-border bg-background pr-3 shadow-[-12px_0_32px_rgba(15,23,42,0.12)] duration-200',
            filePreviewExpanded ? 'min-w-0 flex-1' : 'shrink-0',
            isMobile && 'absolute inset-y-0 right-0 z-40 w-full',
          )}
          style={isMobile || filePreviewExpanded ? undefined : { width: filePreviewWidth }}
          aria-label="文件预览"
        >
          <EditorSidebar {...editorSidebarProps} workspaceMode />
        </aside>
      ) : null}

      {isFiles && showChat ? (
        <aside
          className={cn(
            'z-30 h-full min-h-0 shrink-0 overflow-hidden border-l border-border shadow-[-8px_0_24px_rgba(15,23,42,0.06)]',
            isMobile && 'absolute inset-y-0 right-0 w-full',
          )}
          style={isMobile ? undefined : { width: FILES_PANEL_WIDTH }}
          aria-label="项目文件"
        >
          <Suspense fallback={<TabSkeleton />}>
            <FilesV2
              key={selectedProject?.name ?? ''}
              selectedProject={selectedProject}
              onFileOpen={handleFileOpen}
              activeFilePath={activeFilePath}
              onClose={() => setActiveTab('chat')}
            />
          </Suspense>
        </aside>
      ) : null}

      {dashboardPanelTab ? (
        <ToolSidePanel
          title={t(DASHBOARD_PANEL_META[dashboardPanelTab].labelKey)}
          icon={DASHBOARD_PANEL_META[dashboardPanelTab].icon}
          width={toolPanelWidth}
          minWidth={TOOL_PANEL_MIN_WIDTH}
          maxWidth={toolPanelMaxWidth}
          isMobile={isMobile}
          closeLabel={t('dashboardSwitcher.closePanel', {
            defaultValue: 'Close {{tool}} dashboard',
            tool: t(DASHBOARD_PANEL_META[dashboardPanelTab].labelKey),
          })}
          resizeLabel={t('dashboardSwitcher.resizePanel', {
            defaultValue: 'Resize {{tool}} dashboard',
            tool: t(DASHBOARD_PANEL_META[dashboardPanelTab].labelKey),
          })}
          onClose={() => setActiveTab('chat')}
          onResizeStart={handleToolPanelResizeStart}
          onResizeBy={handleToolPanelResizeBy}
        >
          <Suspense fallback={<TabSkeleton />}>
            {renderTool()}
          </Suspense>
        </ToolSidePanel>
      ) : null}

    </div>
  );
}

export default React.memo(MainContent);
