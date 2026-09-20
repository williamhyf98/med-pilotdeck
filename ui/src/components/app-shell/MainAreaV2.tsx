import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  PanelLeftOpen,
  Search,
} from 'lucide-react';
import type {
  AlwaysOnSubTab,
  AppTab,
  Project,
  ProjectSession,
} from '../../types/app';
import MainContent from '../main-content/view/MainContent';
import {
  ChatHistorySearchControllerProvider,
  useChatHistorySearchController,
} from '../chat-v2/ChatHistorySearchController';
import ChatHistorySearchBar from '../chat-v2/ChatHistorySearchBar';
import type { MainContentProps } from '../main-content/types/types';
import { cn } from '../../lib/utils.js';
import {
  projectDisplayName,
  sessionDisplayTitle,
  setSessionCustomTitle,
  useCustomNamesVersion,
} from '../../lib/customNames';
import { isImeEnterEvent } from '../../utils/ime';
import { FindShortcutProvider } from '../../contexts/FindShortcutContext';

type Tab = { id: AppTab; labelKey: string };

// Chat is the shell's default surface rather than a visible destination.
// Files is the only primary work mode; the remaining management dashboards
// live behind the compact overflow trigger and open beside the conversation.
const FILES_TAB: Tab = { id: 'files', labelKey: 'tabs.files' };
const DASHBOARD_TABS: Tab[] = [
  { id: 'skills', labelKey: 'tabs.skills' },
  { id: 'memory', labelKey: 'tabs.memory' },
  { id: 'storage', labelKey: 'tabs.storage' },
];

const ACTIVE_TOOL_BUTTON_CLASS =
  'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-950/70 dark:text-blue-200 dark:hover:bg-blue-900/70';

// V2 main shell: breadcrumb on the left, tool switcher on the right, and the
// active tool's content below. The sidebar stays focused on projects+sessions.
type MainAreaV2Props = MainContentProps & {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
};

function MainAreaV2Content(props: MainAreaV2Props) {
  const { t } = useTranslation();
  const {
    selectedProject,
    selectedSession,
    activeTab,
    setActiveTab,
    isSidebarCollapsed,
    onOpenSidebar,
  } = props;
  const [alwaysOnSubTab, setAlwaysOnSubTab] = useState<AlwaysOnSubTab>('dashboard');
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const sessionTitleInputRef = useRef<HTMLInputElement | null>(null);
  const chatHistorySearch = useChatHistorySearchController();

  useEffect(() => {
    if (activeTab === 'home') {
      setActiveTab('chat');
    }
  }, [activeTab, setActiveTab]);

  // Re-render breadcrumb when the user renames a project/session via the
  // sidebar overlay (subscribes to localStorage + custom event).
  useCustomNamesVersion();

  // Header title: session title first, project context second. Project +
  // session strings flow through the customNames overlay so user renames in
  // the sidebar reflect here too.
  const displayActiveTab = activeTab === 'home' ? 'chat' : activeTab;
  const activeDashboardTab = DASHBOARD_TABS.find((tab) => tab.id === displayActiveTab) ?? null;
  const tabLabelKey = displayActiveTab === FILES_TAB.id
    ? FILES_TAB.labelKey
    : activeDashboardTab?.labelKey;
  const tabLabel = tabLabelKey
    ? t(tabLabelKey)
    : displayActiveTab.startsWith('plugin:')
      ? displayActiveTab.replace('plugin:', '')
      : displayActiveTab;
  const sessionSummary = selectedSession ? sessionDisplayTitle(selectedSession) : '';
  const projectName = selectedProject
    ? projectDisplayName(selectedProject)
    : t('navigation.home', { defaultValue: 'Home' });
  const headerTitle =
    sessionSummary || (displayActiveTab === FILES_TAB.id ? tabLabel || projectName : projectName);
  const isRenamingSessionTitle = Boolean(
    selectedSession && renamingSessionId === selectedSession.id,
  );
  useEffect(() => {
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!isRenamingSessionTitle) return;
    sessionTitleInputRef.current?.focus();
    sessionTitleInputRef.current?.select();
  }, [isRenamingSessionTitle]);

  const beginSessionTitleRename = () => {
    if (!selectedSession) return;
    setRenamingSessionId(selectedSession.id);
    setSessionTitleDraft(sessionDisplayTitle(selectedSession));
  };

  const commitSessionTitleRename = () => {
    if (!renamingSessionId) return;
    setSessionCustomTitle(renamingSessionId, sessionTitleDraft);
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  };

  const cancelSessionTitleRename = () => {
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  };

  return (
    <div className="workspace-main-surface flex h-full min-w-0 flex-col text-foreground">
      {/* Header: session title left, tool switcher right. */}
      <header className="workspace-header-surface relative z-[80] flex h-14 shrink-0 items-center overflow-visible border-b border-border px-6">
        {isSidebarCollapsed ? (
          // Just the "expand sidebar" affordance — the PilotDeck logo lives
          // in the sidebar header, so showing a duplicate badge here when
          // the sidebar is collapsed feels redundant.
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            title={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            className="mr-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {isRenamingSessionTitle ? (
            <input
              ref={sessionTitleInputRef}
              value={sessionTitleDraft}
              onChange={(event) => setSessionTitleDraft(event.target.value)}
              onBlur={commitSessionTitleRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  if (isImeEnterEvent(event)) return;
                  event.preventDefault();
                  commitSessionTitleRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelSessionTitleRename();
                }
              }}
              aria-label={t('sidebar:sessions.renameSession', { defaultValue: 'Rename Session' }) as string}
              className="h-6 min-w-0 max-w-[34rem] rounded border border-neutral-300 bg-white px-1.5 text-[15px] font-semibold leading-5 text-neutral-950 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
            />
          ) : (
            <div
              className={cn(
                'min-w-0 max-w-[34rem] truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50',
                selectedSession && 'cursor-text',
              )}
              title={headerTitle}
              onDoubleClick={selectedSession ? beginSessionTitleRename : undefined}
            >
              {headerTitle}
            </div>
          )}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-neutral-400 dark:text-neutral-500">
            <Box className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 max-w-[24rem] truncate" title={projectName}>
              {projectName}
            </span>
          </div>
        </div>

        {chatHistorySearch.isOpen && chatHistorySearch.presentation ? (
          <div className="ml-4 w-[min(360px,36vw)] min-w-[240px] shrink">
            <ChatHistorySearchBar
              {...chatHistorySearch.presentation}
              onClose={chatHistorySearch.closeSearch}
              placement="header"
            />
          </div>
        ) : null}

        <div className="ml-4 flex h-9 shrink-0 items-center gap-1" aria-label="Tools">
          <button
            type="button"
            aria-label={t('chatSearch.open', { defaultValue: 'Search current conversation' }) as string}
            aria-pressed={chatHistorySearch.isOpen}
            disabled={!chatHistorySearch.available}
            title={t('chatSearch.openShortcut', {
              defaultValue: 'Search current conversation (Ctrl/⌘+F)',
            }) as string}
            onClick={() => {
              if (chatHistorySearch.isOpen) {
                chatHistorySearch.closeSearch();
                return;
              }
              if (displayActiveTab !== 'chat') setActiveTab('chat');
              chatHistorySearch.openSearch();
            }}
            className={cn(
              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
              chatHistorySearch.isOpen
                ? ACTIVE_TOOL_BUTTON_CLASS
                : chatHistorySearch.available
                  ? 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100'
                  : 'cursor-not-allowed text-neutral-300 dark:text-neutral-700',
            )}
          >
            <Search className="h-4 w-4" strokeWidth={1.9} />
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">
        <MainContent
          {...props}
          alwaysOnSubTab={alwaysOnSubTab}
          onAlwaysOnSubTabChange={setAlwaysOnSubTab}
        />
      </div>
    </div>
  );
}

export default function MainAreaV2(props: MainAreaV2Props) {
  return (
    <FindShortcutProvider activeScope={props.activeTab === 'files' ? 'file' : 'chat'}>
      <ChatHistorySearchControllerProvider>
        <MainAreaV2Content {...props} />
      </ChatHistorySearchControllerProvider>
    </FindShortcutProvider>
  );
}
