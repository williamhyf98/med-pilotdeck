// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSession } from '../../../types/app';
import DialoguePage from './DialoguePage';

const mocks = vi.hoisted(() => ({
  chatProps: null as Record<string, unknown> | null,
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  setSelectedModel: vi.fn(),
}));

vi.mock('../../../components/chat-v2/ChatInterfaceV2', () => ({
  default: (props: {
    welcomeTitle?: string;
    welcomeDescription?: string;
    composerHeader?: ReactNode;
    composerFooterStart?: ReactNode;
    composerFooterEnd?: ReactNode;
  }) => {
    mocks.chatProps = props as Record<string, unknown>;
    return (
      <div data-testid="chat-interface">
        <h1>{props.welcomeTitle}</h1>
        <p>{props.welcomeDescription}</p>
        {props.composerHeader}
        <div>{props.composerFooterStart}</div>
        <div>{props.composerFooterEnd}</div>
      </div>
    );
  },
}));

vi.mock('../shared/MedicalControls', () => ({
  MedicalCapabilityDrawer: ({ capability }: { capability: string | null }) => (
    capability ? <div data-testid="capability-drawer">{capability}</div> : null
  ),
}));

vi.mock('../shared/useMedicalModels', () => ({
  useMedicalModels: () => ({
    options: [{ value: 'medical-model', label: 'G9-V-Med' }],
    selectedModel: 'medical-model',
    setSelectedModel: mocks.setSelectedModel,
    isLoading: false,
  }),
}));

vi.mock('../../../utils/api', () => ({
  api: {
    deleteSession: mocks.deleteSession,
    renameSession: mocks.renameSession,
  },
}));

vi.mock('./dialogueApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('./dialogueApi')>();
  return {
    ...original,
    loadDialogueCapabilities: vi.fn().mockResolvedValue({
      dialogue: true,
      rag: true,
      attachments: true,
      tables: true,
      imaging: true,
      reasons: {},
    }),
    loadCorpora: vi.fn().mockResolvedValue([
      { id: 'medical-corpus', name: '医学语料', ready: true },
    ]),
  };
});

const session = {
  id: 'session-1',
  title: '伤情复盘',
  updated_at: new Date().toISOString(),
} as unknown as ProjectSession;

const project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
  sessions: [session],
} as Project;

function renderPage(overrides: Partial<ComponentProps<typeof DialoguePage>> = {}) {
  const props = {
    selectedProject: project,
    selectedSession: null,
    processingSessions: new Set<string>(),
    unreadSessionIds: new Set<string>(),
    onSelectSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onOpenTrauma: vi.fn(),
    chatProps: {
      selectedProject: project,
      selectedSession: null,
      ws: null,
      sendMessage: vi.fn(),
    },
    ...overrides,
  } as unknown as ComponentProps<typeof DialoguePage>;
  return { ...render(<DialoguePage {...props} />), props };
}

describe('DialoguePage legacy-native shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatProps = null;
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1_440,
      writable: true,
    });
    mocks.renameSession.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    mocks.deleteSession.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
  });

  afterEach(() => {
    cleanup();
    delete window.refreshProjects;
    vi.restoreAllMocks();
  });

  it('renders the immersive military Dialogue chrome and composer controls', async () => {
    renderPage({
      selectedProject: { ...project, sessions: [] },
    });

    const page = screen.getByTestId('medical-dialogue-page');
    expect(page.classList.contains('fixed')).toBe(true);
    expect(page.parentElement).toBe(document.body);
    expect(page.getAttribute('data-theme')).toBe('military');
    expect(page.getAttribute('data-sidebar-collapsed')).toBe('false');
    expect(screen.getByText('九格医学对话助手')).toBeTruthy();
    expect(screen.getByText('医学辅助对话')).toBeTruthy();
    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新对话' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '创伤辅助救治助手' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '系统配置' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加附件' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '选择模型' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '选择医疗任务模式' })).toBeTruthy();
    expect(screen.getByText('您好，我是九格医学辅助对话助手')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '系统配置' }));
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '启用医学检索' }).hasAttribute('disabled')).toBe(false);
    });
    expect(screen.getByRole('checkbox', { name: '启用模型思考' })).toBeTruthy();
    expect(mocks.chatProps).toEqual(expect.objectContaining({
      composerChrome: 'medical',
      modelOverride: 'medical-model',
      welcomeDescription: expect.stringContaining('战创伤诊断'),
    }));
  });

  it('keeps task, RAG, Think, workbench and navigation actions connected', async () => {
    const { props } = renderPage();

    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    expect(props.onStartNewSession).toHaveBeenCalledWith(
      project,
      { preserveActiveTab: true },
    );

    fireEvent.change(screen.getByRole('combobox', { name: '选择医疗任务模式' }), {
      target: { value: 'report-interpretation' },
    });
    expect(mocks.chatProps).toEqual(expect.objectContaining({
      profileOverride: 'medical-report',
      composerPlaceholder: expect.stringContaining('结构化解读'),
    }));

    fireEvent.click(screen.getByRole('button', { name: '系统配置' }));
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '启用医学检索' }).hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByRole('checkbox', { name: '启用医学检索' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '启用模型思考' }));
    expect((screen.getByRole('checkbox', { name: '启用医学检索' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: '启用模型思考' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('heading', { name: '系统配置' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '能力状态' }));
    expect(screen.getByTestId('capability-drawer').textContent).toBe('status');

    fireEvent.click(screen.getByRole('button', { name: '创伤辅助救治助手' }));
    expect(props.onOpenTrauma).toHaveBeenCalledOnce();
  });

  it('preserves session selection, rename, delete and stop generation', async () => {
    const refreshProjects = vi.fn().mockResolvedValue(undefined);
    window.refreshProjects = refreshProjects;
    vi.spyOn(window, 'prompt').mockReturnValue('战创伤复盘');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const sendMessage = vi.fn();
    const { props } = renderPage({
      selectedSession: session,
      processingSessions: new Set([session.id]),
      chatProps: {
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage,
      } as never,
    });

    fireEvent.click(screen.getByRole('button', { name: /伤情复盘/u }));
    expect(props.onSelectSession).toHaveBeenCalledWith(
      project,
      session.id,
      session,
      { preserveActiveTab: true },
    );

    fireEvent.click(screen.getByRole('button', { name: '重命名会话' }));
    await waitFor(() => expect(mocks.renameSession).toHaveBeenCalledWith(
      session.id,
      '战创伤复盘',
      'pilotdeck',
    ));

    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'abort-session',
      sessionId: session.id,
      provider: 'pilotdeck',
    });

    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
    await waitFor(() => expect(mocks.deleteSession).toHaveBeenCalled());
    expect(refreshProjects).toHaveBeenCalled();
  });
});
