// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppTab, Project } from '../../../types/app';
import MainContent from './MainContent';

const mocks = vi.hoisted(() => ({
  handleFileOpen: vi.fn(),
  onMisroutedFileUrlHandled: vi.fn(),
  chatProps: [] as any[],
}));

vi.mock('../../../contexts/TaskMasterContext', () => ({
  useTaskMaster: () => ({
    currentProject: { name: 'pilotdeck' },
    setCurrentProject: vi.fn(),
  }),
}));

vi.mock('../../../contexts/TasksSettingsContext', () => ({
  useTasksSettings: () => ({
    tasksEnabled: false,
    isTaskMasterInstalled: false,
    isTaskMasterReady: false,
  }),
}));

vi.mock('../../../hooks/useUiPreferences', () => ({
  useUiPreferences: () => ({
    preferences: {
      autoExpandTools: false,
      showRawParameters: false,
      showThinking: false,
      inlineThinking: false,
      autoScrollToBottom: true,
      sendByCtrlEnter: false,
    },
  }),
}));

vi.mock('../../code-editor/hooks/useEditorSidebar', () => ({
  useEditorSidebar: () => ({
    editorTabs: [{
      id: 'editor-tab-0',
      fileStack: [{
        name: 'report.pdf',
        path: '/workspace/PilotDeck/report.pdf',
        projectName: 'pilotdeck',
        diffInfo: null,
      }],
      dirty: false,
    }],
    activeEditorTabId: 'editor-tab-0',
    activeFilePath: '/workspace/PilotDeck/report.pdf',
    editingFile: {
      name: 'report.pdf',
      path: '/workspace/PilotDeck/report.pdf',
      projectName: 'pilotdeck',
      diffInfo: null,
    },
    editorWidth: 600,
    editorExpanded: false,
    hasManualWidth: false,
    resizeHandleRef: { current: null },
    handleFileOpen: mocks.handleFileOpen,
    handlePreviewFileOpen: vi.fn(),
    handleFileGoBack: vi.fn(),
    handleTabSelect: vi.fn(),
    handleTabClose: vi.fn(),
    handleTabDirtyChange: vi.fn(),
    handleFileRename: vi.fn(),
    handleFileDelete: vi.fn(),
    handleToggleEditorExpand: vi.fn(),
    handleResizeStart: vi.fn(),
  }),
}));

vi.mock('../../code-editor/view/EditorSidebar', () => ({
  default: () => <div data-testid="editor-sidebar" />,
}));

vi.mock('../../chat-v2/ChatInterfaceV2', () => ({
  default: (props: {
    onFileOpen: (filePath: string) => void;
    hideComposer?: boolean;
    hiddenComposerNotice?: string;
  }) => {
    mocks.chatProps.push(props);
    return (
      <div data-testid="runtime-chat" data-hide-composer={String(Boolean(props.hideComposer))}>
        {props.hiddenComposerNotice ? <p role="note">{props.hiddenComposerNotice}</p> : null}
        <button type="button" onClick={() => props.onFileOpen('/workspace/PilotDeck/generated.pptx')}>
          Open workspace file
        </button>
      </div>
    );
  },
}));

vi.mock('../../main-content-v2/FilesV2', () => ({
  default: () => <div data-testid="files-explorer" />,
}));

vi.mock('../../plugins/view/PluginTabContent', () => ({
  default: () => null,
}));

vi.mock('./ErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

class ResizeObserverMock {
  observe() {}

  disconnect() {}
}

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
};

function propsFor(activeTab: AppTab, setActiveTab = vi.fn()) {
  return {
    projects: [project],
    selectedProject: project,
    selectedSession: null,
    activeTab,
    setActiveTab,
    ws: null,
    sendMessage: vi.fn(),
    latestMessage: null,
    isMobile: false,
    onMenuClick: vi.fn(),
    isLoading: false,
    onInputFocusChange: vi.fn(),
    onSessionActive: vi.fn(),
    onSessionInactive: vi.fn(),
    onSessionProcessing: vi.fn(),
    onSessionNotProcessing: vi.fn(),
    processingSessions: new Set<string>(),
    unreadSessionIds: new Set<string>(),
    onReplaceTemporarySession: vi.fn(),
    onNavigateToSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onShowSettings: vi.fn(),
    externalMessageUpdate: 0,
  } as unknown as ComponentProps<typeof MainContent>;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Trauma case polling (useCaseStore) returns an empty case payload.
    if (url.includes('/api/trauma/cases/') && !url.includes('/extract')) {
      return new Response(JSON.stringify({ current: null, snapshots: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Trauma extraction endpoint — return a structured form mirroring the raw text.
    if (url.includes('/extract')) {
      return new Response(JSON.stringify({
        extracted: {
          injuryNarratives: [{ text: '右小腿开放伤' }],
          treatmentNarratives: [],
          evacuationNarratives: [],
          notes: [],
          vitals: [{ field: 'heartRate', value: 118 }],
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  localStorage.clear();
  mocks.handleFileOpen.mockReset();
  mocks.onMisroutedFileUrlHandled.mockReset();
  mocks.chatProps.length = 0;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('MainContent file workspace routing', () => {
  it('routes every chat file open into the Files workbench', async () => {
    const setActiveTab = vi.fn();
    const { rerender } = render(<MainContent {...propsFor('files', setActiveTab)} />);

    expect(await screen.findByTestId('editor-sidebar')).not.toBeNull();

    rerender(<MainContent {...propsFor('chat', setActiveTab)} />);
    expect(screen.queryByTestId('editor-sidebar')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open workspace file' }));
    expect(mocks.handleFileOpen).toHaveBeenCalledWith(
      '/workspace/PilotDeck/generated.pptx',
      null,
    );
    expect(setActiveTab).toHaveBeenCalledWith('files');
    expect(screen.queryByTestId('editor-sidebar')).toBeNull();
  });

  it('routes a file-shaped session URL into Files instead of chat', async () => {
    const setActiveTab = vi.fn();
    render(
      <MainContent
        {...propsFor('chat', setActiveTab)}
        misroutedFileFromUrl="/workspace/PilotDeck/report.pdf"
        onMisroutedFileUrlHandled={mocks.onMisroutedFileUrlHandled}
      />,
    );

    await waitFor(() => {
      expect(mocks.handleFileOpen).toHaveBeenCalledWith(
        '/workspace/PilotDeck/report.pdf',
        null,
      );
    });
    expect(setActiveTab).toHaveBeenCalledWith('files');
    expect(setActiveTab).not.toHaveBeenCalledWith('chat');
    expect(mocks.onMisroutedFileUrlHandled).toHaveBeenCalledOnce();
  });

  it('keeps the agent panel collapsible and persists keyboard resizing', async () => {
    render(<MainContent {...propsFor('files')} />);

    const conversationTrigger = await screen.findByTestId('files-conversation-switcher-trigger');
    const labels = conversationTrigger.querySelectorAll('span.block');
    expect(labels[0]?.textContent).toBe('filesWorkbench.assistant');
    expect(labels[1]?.textContent).toBe('filesWorkbench.conversations.newConversation');

    const resizeHandle = screen.getByRole('separator', {
      name: 'filesWorkbench.resizeAssistant',
    });
    expect(resizeHandle.getAttribute('aria-valuenow')).toBe('380');

    fireEvent.keyDown(resizeHandle, { key: 'ArrowLeft' });
    expect(resizeHandle.getAttribute('aria-valuenow')).toBe('396');
    await waitFor(() => {
      expect(localStorage.getItem('pilotdeck:files-assistant-width')).toBe('396');
    });

    fireEvent.click(screen.getByRole('button', { name: 'filesWorkbench.collapseAssistant' }));
    expect(screen.queryByRole('separator', { name: 'filesWorkbench.resizeAssistant' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'filesWorkbench.openAssistant' }));
    expect(screen.getByRole('separator', {
      name: 'filesWorkbench.resizeAssistant',
    }).getAttribute('aria-valuenow')).toBe('396');
  });
});

describe('MainContent project-type workspace routing', () => {
  it('wraps war-trauma chat in the dedicated treatment workspace', () => {
    const traumaProject: Project = {
      ...project,
      name: 'trauma_med-demo',
      displayName: '战创伤演练',
    };
    render(
      <MainContent
        {...propsFor('chat')}
        projects={[traumaProject]}
        selectedProject={traumaProject}
      />,
    );

    expect(screen.getByRole('heading', { name: '分级救治全过程' })).not.toBeNull();
    expect(screen.getByLabelText('本轮伤情自由输入')).not.toBeNull();
    expect(screen.getByRole('region', { name: '推演对话' })).not.toBeNull();
    expect(screen.getByTestId('runtime-chat').getAttribute('data-hide-composer')).toBe('true');
    expect(mocks.chatProps.some((props) => props.hideComposer === true)).toBe(true);
  });

  it('submits free-text trauma input and launches an extraction turn', async () => {
    const traumaProject: Project = {
      ...project,
      name: 'trauma_med-demo',
      displayName: '战创伤演练',
    };
    const props = propsFor('chat');
    const { rerender } = render(
      <MainContent
        {...props}
        projects={[traumaProject]}
        selectedProject={traumaProject}
      />,
    );

    fireEvent.change(screen.getByLabelText('本轮伤情自由输入'), {
      target: { value: '右小腿开放伤，心率 118' },
    });
    fireEvent.click(screen.getByRole('button', { name: '整理' }));

    await waitFor(() => expect(props.sendMessage).toHaveBeenCalled());
    expect(props.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pilotdeck-command',
      options: expect.objectContaining({
        traumaForm: expect.objectContaining({
          injuryNarrative: '右小腿开放伤，心率 118',
          vitals: {},
        }),
        traumaRawInput: '右小腿开放伤，心率 118',
        traumaExtract: true,
        userVisibleInput: '右小腿开放伤，心率 118',
      }),
    }));
    expect(screen.getByTestId('runtime-chat')).not.toBeNull();
    expect(screen.getByRole('region', { name: '推演对话' })).not.toBeNull();

    rerender(
      <MainContent
        {...props}
        projects={[traumaProject]}
        selectedProject={traumaProject}
        selectedSession={{ id: 'web:s-created' } as any}
      />,
    );
    expect(screen.getByTestId('runtime-chat')).not.toBeNull();

    window.dispatchEvent(new CustomEvent('pilotdeck:agent-turn-complete', {
      detail: { projectName: traumaProject.name, sessionId: 'web:s-created' },
    }));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: '推演实时进度' })).toBeNull();
    });
  });

  it('keeps general-medicine chat on the standard surface', () => {
    render(<MainContent {...propsFor('chat')} />);

    expect(screen.queryByRole('heading', { name: '分级救治全过程' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open workspace file' })).not.toBeNull();
  });

  it('directs trauma Files users to the structured form workspace', () => {
    const traumaProject: Project = {
      ...project,
      name: 'trauma_med-demo',
      displayName: '战创伤演练',
    };
    render(
      <MainContent
        {...propsFor('files')}
        projects={[traumaProject]}
        selectedProject={traumaProject}
      />,
    );

    expect(screen.getByRole('note').textContent).toContain('切换到对话工作区');
    expect(mocks.chatProps.some((props) => props.hideComposer === true)).toBe(true);
  });
});
