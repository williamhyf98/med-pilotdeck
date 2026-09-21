// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FindShortcutProvider } from '../../contexts/FindShortcutContext';
import type { ChatMessage, ChatRunMode } from '../chat/types/types';
import type { Project } from '../../types/app';
import MessagesPaneV2 from './MessagesPaneV2';
import { getContextStatus } from './ComposerV2';

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('getContextStatus', () => {
  it('keeps the visible count and percentage on the same display-token basis', () => {
    const status = getContextStatus({
      displayUsed: 11_928,
      budgetUsed: 12_080,
      total: 12_000,
      effectiveTotal: 12_000,
      state: 'blocking',
    });

    expect(status.used).toBe(11_928);
    expect(status.percentLabel).toBe('99%');
    // The padded request budget still controls the policy severity.
    expect(status.state).toBe('blocking');
    expect(status.tone).toBe('red');
  });
});

function makeMessage(index: number): ChatMessage {
  return {
    id: `m-${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index}`,
    timestamp: `2026-05-13T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
  };
}

function createPaneElement({
  messages,
  activityMessages = [],
  isAssistantWorking = false,
  runMode = 'agent',
  planModeActive = false,
  showThinking,
  showProcessTrace,
  navigateToChatMessageRef,
  selectedProject = null,
}: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  isAssistantWorking?: boolean;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
  showThinking?: boolean;
  showProcessTrace?: boolean;
  navigateToChatMessageRef?: React.MutableRefObject<((runId: string) => void | Promise<void>) | null>;
  selectedProject?: Project | null;
}) {
  const scrollContainerRef = React.createRef<HTMLDivElement>();

  return (
    <FindShortcutProvider activeScope="chat">
      <MessagesPaneV2
        scrollContainerRef={scrollContainerRef}
        onWheel={() => {}}
        onTouchMove={() => {}}
        isLoadingSessionMessages={false}
        chatMessages={messages}
        activityMessages={activityMessages}
        visibleMessages={messages}
        visibleMessageCount={messages.length}
        isLoadingMoreMessages={false}
        hasMoreMessages={false}
        totalMessages={messages.length}
        loadEarlierMessages={() => {}}
        loadAllMessages={() => {}}
        navigateToChatMessageRef={navigateToChatMessageRef}
        allMessagesLoaded
        isLoadingAllMessages={false}
        provider="pilotdeck"
        selectedProject={selectedProject}
        selectedSession={null}
        createDiff={() => []}
        setInput={() => {}}
        isAssistantWorking={isAssistantWorking}
        runMode={runMode}
        planModeActive={planModeActive}
        showThinking={showThinking}
        showProcessTrace={showProcessTrace}
      />
    </FindShortcutProvider>
  );
}

function renderPane(options: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  isAssistantWorking?: boolean;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
  showThinking?: boolean;
  showProcessTrace?: boolean;
  navigateToChatMessageRef?: React.MutableRefObject<((runId: string) => void | Promise<void>) | null>;
  selectedProject?: Project | null;
}) {
  return render(createPaneElement(options));
}

function SessionPaneHarness({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: ChatMessage[];
}) {
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  return (
    <FindShortcutProvider activeScope="chat">
      <MessagesPaneV2
        scrollContainerRef={scrollContainerRef}
        onWheel={() => {}}
        onTouchMove={() => {}}
        isLoadingSessionMessages={false}
        chatMessages={messages}
        visibleMessages={messages}
        visibleMessageCount={messages.length}
        isLoadingMoreMessages={false}
        hasMoreMessages={false}
        totalMessages={messages.length}
        loadEarlierMessages={() => {}}
        loadAllMessages={() => {}}
        allMessagesLoaded
        isLoadingAllMessages={false}
        provider="pilotdeck"
        selectedProject={{ name: 'project', displayName: 'Project', fullPath: '/project' }}
        selectedSession={{ id: sessionId }}
        createDiff={() => []}
        setInput={() => {}}
      />
    </FindShortcutProvider>
  );
}

describe('MessagesPaneV2 render behavior', () => {
  it('hides thinking, narration, and successful tool trace while keeping the final answer', () => {
    renderPane({
      showProcessTrace: false,
      showThinking: true,
      messages: [
        {
          id: 'u-final-only',
          type: 'user',
          content: '分析这份 CT',
          timestamp: '2026-09-20T08:00:00.000Z',
        },
        {
          id: 'thinking-final-only',
          type: 'assistant',
          content: 'The user wants me to inspect the scan and call RADAR.',
          timestamp: '2026-09-20T08:00:01.000Z',
          isThinking: true,
        },
        {
          id: 'narration-final-only',
          type: 'assistant',
          content: 'I will invoke the RADAR tool now.',
          timestamp: '2026-09-20T08:00:02.000Z',
        },
        {
          id: 'tool-final-only',
          type: 'assistant',
          content: '',
          timestamp: '2026-09-20T08:00:03.000Z',
          isToolUse: true,
          toolName: 'med_radar_analyze_ct',
          toolResult: { content: 'RADAR completed', isError: false },
        },
        {
          id: 'answer-final-only',
          type: 'assistant',
          content: 'The artifact exists and the CSV is in the correct format.\n\nRADAR 分析已完成。以下按技能规定结构报告：\n\n最终结果：未发现明确异常。',
          timestamp: '2026-09-20T08:00:04.000Z',
        },
      ],
    });

    expect(screen.queryByText(/The user wants me/)).toBeNull();
    expect(screen.queryByText(/invoke the RADAR tool/)).toBeNull();
    expect(screen.queryByText('med_radar_analyze_ct')).toBeNull();
    expect(screen.queryByText(/^Processed /)).toBeNull();
    expect(screen.getByText('最终结果：未发现明确异常。')).toBeTruthy();
    // Final answer text must not be cropped using a RADAR phrase heuristic.
    expect(screen.getByText(/The artifact exists/)).toBeTruthy();
  });

  it('shows only a generic processing status while a final-only turn is running', () => {
    renderPane({
      showProcessTrace: false,
      showThinking: true,
      isAssistantWorking: true,
      messages: [
        {
          id: 'u-running-final-only',
          type: 'user',
          content: '继续分析',
          timestamp: '2026-09-20T08:01:00.000Z',
        },
        {
          id: '__streaming_thinking_final_only',
          type: 'assistant',
          content: 'I need to inspect the RADAR output.',
          timestamp: '2026-09-20T08:01:01.000Z',
          isThinking: true,
          isStreaming: true,
        },
        {
          id: 'tool-completed-final-only',
          type: 'assistant',
          content: '',
          timestamp: '2026-09-20T08:01:01.500Z',
          isToolUse: true,
          toolName: 'med_radar_analyze_ct',
          toolResult: { content: 'completed', isError: false },
        },
        {
          id: 'partial-final-only',
          type: 'assistant',
          content: '正在读取中间结果',
          timestamp: '2026-09-20T08:01:02.000Z',
          isStreaming: true,
        },
      ],
    });

    expect(screen.getByText(/Completed: RADAR CT/)).toBeTruthy();
    expect(screen.queryByText(/inspect the RADAR output/)).toBeNull();
    expect(screen.queryByText('正在读取中间结果')).toBeNull();
    fireEvent.click(screen.getByText(/Completed: RADAR CT/));
    expect(screen.getByText('RADAR CT 分析')).toBeTruthy();
  });

  it('shows sanitized medical activity while the raw process trace is hidden', () => {
    renderPane({
      showProcessTrace: false,
      isAssistantWorking: true,
      messages: [{
        id: 'u-medical-status',
        type: 'user',
        content: '分析这个 DICOM',
        timestamp: '2026-09-21T08:00:00.000Z',
      }],
      activityMessages: [{
        id: 'medical-call-route',
        type: 'system',
        content: '正在读取 DICOM 元数据',
        timestamp: '2026-09-21T08:00:01.000Z',
        isAgentActivity: true,
        activityId: 'medical:call-route',
        phase: 'medical',
        state: 'running',
        title: '正在读取 DICOM 元数据',
        detail: '本地识别模态、部位和序列完整性',
        toolName: 'mcp__med-tools__med_dicom_route',
      }],
    });

    expect(screen.getByText('正在读取 DICOM 元数据')).toBeTruthy();
    expect(screen.queryByText('mcp__med-tools__med_dicom_route')).toBeNull();
  });

  it('keeps errors and interactive prompts visible in final-only mode', () => {
    renderPane({
      showProcessTrace: false,
      messages: [
        {
          id: 'u-safety-final-only',
          type: 'user',
          content: '执行检查',
          timestamp: '2026-09-20T08:02:00.000Z',
        },
        {
          id: 'error-final-only',
          type: 'error',
          content: 'RADAR 服务暂时不可用',
          timestamp: '2026-09-20T08:02:01.000Z',
        },
        {
          id: 'prompt-final-only',
          type: 'assistant',
          content: '请选择要分析的序列',
          timestamp: '2026-09-20T08:02:02.000Z',
          isInteractivePrompt: true,
        },
      ],
    });

    expect(screen.getByText('RADAR 服务暂时不可用')).toBeTruthy();
    expect(screen.getByText('请选择要分析的序列')).toBeTruthy();
  });

  it('prefers a persisted direct medical report over later agent narration', () => {
    renderPane({
      showProcessTrace: false,
      messages: [
        {
          id: 'u-direct-report',
          type: 'user',
          content: '分析这个 DICOM',
          timestamp: '2026-09-21T08:03:00.000Z',
        },
        {
          id: 'direct-report',
          type: 'assistant',
          content: '## 资料概况\n\n完整医学报告。',
          timestamp: '2026-09-21T08:03:01.000Z',
          metadata: { directToolOutput: true },
        },
        {
          id: 'later-narration',
          type: 'assistant',
          content: 'The report was generated and the task is complete.',
          timestamp: '2026-09-21T08:03:02.000Z',
        },
      ],
    });

    expect(screen.getByText('完整医学报告。')).toBeTruthy();
    expect(screen.queryByText(/report was generated/)).toBeNull();
  });

  it('never replaces the saved answer with an unmarked tool report', () => {
    renderPane({
      showProcessTrace: false,
      messages: [
        {
          id: 'u-recovered-report',
          type: 'user',
          content: '分析这个 DICOM',
          timestamp: '2026-09-21T08:04:00.000Z',
        },
        {
          id: 'tool-recovered-report',
          type: 'assistant',
          content: '',
          timestamp: '2026-09-21T08:04:01.000Z',
          isToolUse: true,
          toolName: 'mcp__med-tools__med_parse_medical',
          toolResult: {
            isError: false,
            content: JSON.stringify({ ok: true, report: '## 资料概况\n\n从旧会话恢复的完整医学报告。' }),
          },
        },
        {
          id: 'old-agent-narration',
          type: 'assistant',
          content: 'The tool report is available above.',
          timestamp: '2026-09-21T08:04:02.000Z',
        },
      ],
    });

    expect(screen.queryByText('从旧会话恢复的完整医学报告。')).toBeNull();
    expect(screen.getByText(/tool report is available/)).toBeTruthy();
  });

  it('places the completed thinking summary and answer in one assistant turn panel', () => {
    renderPane({
      showThinking: true,
      messages: [
        {
          id: 'u-1',
          type: 'user',
          content: '头痛伴发热两天',
          timestamp: '2026-09-18T08:00:00.000Z',
        },
        {
          id: 'thinking-1',
          type: 'assistant',
          content: '正在分析症状和危险信号。',
          timestamp: '2026-09-18T08:00:01.000Z',
          isThinking: true,
        },
        {
          id: 'a-1',
          type: 'assistant',
          content: '建议首先测量体温并评估伴随症状。',
          timestamp: '2026-09-18T08:00:02.000Z',
        },
      ],
    });

    const processSummary = screen.getByText('Thought through next step');
    const runSummary = screen.getByText(/^Processed /);
    const answer = screen.getByText('建议首先测量体温并评估伴随症状。');
    const panel = answer.closest('.pd-assistant-turn-surface-single');

    expect(panel).toBeTruthy();
    expect(panel?.contains(processSummary)).toBe(true);
    expect(panel?.contains(runSummary)).toBe(true);
  });

  it('shows the trauma-specific empty state for a new war-trauma conversation', () => {
    renderPane({
      messages: [],
      selectedProject: {
        name: 'trauma_med-field',
        displayName: '战创伤项目',
        fullPath: '/ws/trauma_med-field',
        projectType: 'war_trauma',
      },
    });

    expect(screen.getByText('战创伤救治推演助手')).toBeTruthy();
    expect(screen.getByText(/输入伤员的自由描述/)).toBeTruthy();
    expect(screen.queryByText('开始新对话')).toBeNull();
    expect(screen.queryByText('Start a new conversation')).toBeNull();
    const logo = screen.getByAltText('Trauma Agent');
    expect(screen.queryByText(/^Trauma Agent$/i)).toBeNull();
    expect(logo.className).toContain('h-auto');
    expect(logo.className).toContain('w-52');
    expect(logo.className).toContain('mb-3');
    expect(logo.className).not.toContain('h-64');
    expect(logo.parentElement?.className).not.toContain('border');
  });

  it('removes the trauma empty state once the first message is visible', () => {
    renderPane({
      messages: [{
        id: 'u-1',
        type: 'user',
        content: '爆炸伤，右大腿活动性出血',
        timestamp: '2026-09-09T00:00:00.000Z',
      }],
      selectedProject: {
        name: 'trauma_med-field',
        displayName: '战创伤项目',
        fullPath: '/ws/trauma_med-field',
        projectType: 'war_trauma',
      },
    });

    expect(screen.queryByText('战创伤救治推演助手')).toBeNull();
    expect(screen.getByText('爆炸伤，右大腿活动性出血')).toBeTruthy();
  });

  it('renders the trauma stop copy without processed status or process steps', () => {
    renderPane({
      messages: [
        {
          id: 'u-1',
          type: 'user',
          content: '胸部爆震伤，呼吸困难',
          timestamp: '2026-09-16T08:00:00.000Z',
        },
        {
          id: 'trauma-step-1',
          type: 'assistant',
          content: '',
          timestamp: '2026-09-16T08:00:01.000Z',
          isToolUse: true,
          toolName: '读取病例状态',
          toolId: 'trauma-step-1',
          toolInput: {
            traumaRunnerStep: true,
            stepNumber: 1,
            phase: 'trauma',
            title: '读取病例状态',
            runningTitle: '正在读取病例状态',
            expectedTotalSteps: 11,
          },
        },
        {
          id: 'stopped-notice',
          type: 'system',
          content: '本轮推演已停止。',
          timestamp: '2026-09-16T08:00:02.000Z',
          isInterruptedNotice: true,
        },
        {
          id: 'summary-1',
          type: 'system',
          content: 'Process summary',
          timestamp: '2026-09-16T08:00:02.000Z',
          isAgentActivitySummary: true,
          durationMs: 2000,
          state: 'cancelled',
        },
      ],
      isAssistantWorking: true,
      selectedProject: {
        name: 'trauma_med-field',
        displayName: '战创伤项目',
        fullPath: '/ws/trauma_med-field',
        projectType: 'war_trauma',
      },
    });

    expect(screen.getByText('本轮推演已停止。')).toBeTruthy();
    expect(screen.queryByText(/已处理|Processed/)).toBeNull();
    expect(screen.queryByText('读取病例状态')).toBeNull();
    expect(screen.queryByText('已被用户暂停')).toBeNull();
  });

  it('renders the default 100-message window without virtualization', () => {
    const messages = Array.from({ length: 100 }, (_, index) => makeMessage(index));

    renderPane({ messages });

    const container = screen.getByText('Message 0').closest('[data-total-message-count]');
    expect(container?.getAttribute('data-virtualized-messages')).toBeNull();
    expect(container?.getAttribute('data-rendered-message-count')).toBe('100');
  });

  it('renders only the viewport window for large conversations', () => {
    const messages = Array.from({ length: 220 }, (_, index) => makeMessage(index));

    renderPane({ messages });

    const container = screen.getByText('Message 0').closest('[data-total-message-count]');
    expect(container?.getAttribute('data-virtualized-messages')).toBe('true');
    expect(container?.getAttribute('data-total-message-count')).toBe('220');
    expect(Number(container?.getAttribute('data-rendered-message-count'))).toBeLessThan(220);
  });

  it('resynchronizes a virtual window when the mounted pane changes sessions', async () => {
    const sessionAMessages = Array.from({ length: 220 }, (_, index) => ({
      ...makeMessage(index),
      content: `Session A message ${index}`,
    }));
    const sessionBMessages = Array.from({ length: 220 }, (_, index) => ({
      ...makeMessage(index),
      content: `Session B message ${index}`,
    }));
    const view = render(
      <SessionPaneHarness sessionId="session-a" messages={sessionAMessages} />,
    );
    const scrollSurface = view.container.querySelector<HTMLElement>('[data-chat-search-surface]');
    expect(scrollSurface).not.toBeNull();
    Object.defineProperty(scrollSurface, 'clientHeight', { configurable: true, value: 800 });

    scrollSurface!.scrollTop = 5000;
    fireEvent.scroll(scrollSurface!);
    await waitFor(() => {
      expect(screen.queryByText('Session A message 0')).toBeNull();
    });

    // Simulate the browser clamping the reused element without dispatching a
    // scroll event while React replaces the conversation contents.
    scrollSurface!.scrollTop = 0;
    view.rerender(
      <SessionPaneHarness sessionId="session-b" messages={sessionBMessages} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Session B message 0')).toBeTruthy();
    });
  });

  it('resets completed process expansion when switching conversations', async () => {
    const processMessages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '检查文件',
        timestamp: '2026-09-18T08:00:00.000Z',
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: '2026-09-18T08:00:01.000Z',
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/ReadHidden.tsx"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'Done.',
        timestamp: '2026-09-18T08:00:02.000Z',
      },
    ];
    const view = render(
      <SessionPaneHarness sessionId="session-a" messages={processMessages} />,
    );

    const firstButton = screen.getByText('Explored 1 file').closest('button');
    fireEvent.click(firstButton as HTMLButtonElement);
    expect(firstButton?.getAttribute('aria-expanded')).toBe('true');

    view.rerender(
      <SessionPaneHarness sessionId="session-b" messages={processMessages} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Explored 1 file').closest('button')?.getAttribute('aria-expanded'))
        .toBe('false');
    });
  });

  it('renders live processing time above the active assistant turn with activity status', () => {
    const messages = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续优化',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect the current UI.',
        timestamp: new Date().toISOString(),
      },
    ];
    const activityMessages: ChatMessage[] = [
      {
        id: 'activity-1',
        type: 'system',
        content: 'Searching files',
        timestamp: new Date().toISOString(),
        isAgentActivity: true,
        activityId: 'activity-1',
        phase: 'rag',
        state: 'running',
        title: 'Searching files',
        detail: 'MessagesPaneV2.tsx',
        startedAt: new Date(Date.now() - 2000).toISOString(),
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    const statuses = screen.getAllByRole('status');
    const headerStatus = statuses[0];
    const liveStatus = statuses[1];
    const userText = screen.getByText('继续优化');
    const assistantText = screen.getByText('I will inspect the current UI.');
    expect(statuses).toHaveLength(2);
    expect(headerStatus.textContent).toContain('Processed');
    expect(headerStatus.querySelector('button')).toBeNull();
    expect(userText.closest('.chat-message')?.className).toContain('pb-2');
    expect(liveStatus.textContent).toContain('Searching files');
    expect(liveStatus.querySelector('button')).toBeNull();
    expect(Boolean(headerStatus.compareDocumentPosition(assistantText) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('scrolls to a message by trauma run id', async () => {
    const navigateRef = React.createRef<((runId: string) => void | Promise<void>) | null>();
    renderPane({
      navigateToChatMessageRef: navigateRef,
      messages: [
        {
          ...makeMessage(0),
          type: 'user',
          runId: 'run-target',
          turnId: 'run-target',
          content: '目标输入',
        },
        makeMessage(1),
      ],
    });

    await waitFor(() => expect(navigateRef.current).toBeTypeOf('function'));
    await navigateRef.current?.('run-target');

    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'center',
      });
    });
  });

  it('keeps the processed duration visible after the active turn completes', () => {
    const now = '2026-05-18T08:00:00.000Z';
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续优化',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I finished the changes.',
        timestamp: '2026-05-18T08:01:20.000Z',
      },
      {
        id: 'summary-1',
        type: 'system',
        content: 'Process summary',
        timestamp: '2026-05-18T08:01:20.000Z',
        isAgentActivitySummary: true,
        durationMs: 80000,
        state: 'completed',
      },
    ];

    renderPane({ messages });

    const headerStatus = screen.getByText('Processed 1m 20s').closest('[role="status"]');
    const userText = screen.getByText('继续优化');
    const assistantText = screen.getByText('I finished the changes.');

    expect(headerStatus).not.toBeNull();
    expect(headerStatus?.querySelector('button')).toBeNull();
    expect(Boolean(userText.compareDocumentPosition(headerStatus as Element) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean((headerStatus as Element).compareDocumentPosition(assistantText) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('keeps live tool calls collapsed but lets the running status expand their details', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '检查文件',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect the current file.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/HiddenTool.tsx"}',
      },
    ];
    const activityMessages: ChatMessage[] = [
      {
        id: 'activity-1',
        type: 'system',
        content: 'Reading file',
        timestamp: now,
        isAgentActivity: true,
        activityId: 'activity-1',
        phase: 'tool',
        state: 'running',
        title: 'Reading file',
        startedAt: now,
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    expect(screen.queryByText('HiddenTool.tsx')).toBeNull();

    const liveStatus = screen.getByText('Reading file').closest('[role="status"]');
    expect(liveStatus).not.toBeNull();
    if (!liveStatus) throw new Error('Expected live status container');
    const expandButton = liveStatus.querySelector('button');
    expect(expandButton).not.toBeNull();
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(expandButton as HTMLButtonElement);

    expect(expandButton?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('HiddenTool.tsx')).toBeTruthy();
  });

  it('renders expanded plan-mode bash denials as neutral collapsed tool details', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '列一下文件',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect the current directory.',
        timestamp: now,
      },
      {
        id: 'tool-bash-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'bash',
        toolId: 'tool-bash-1',
        toolInput: '{"command":"find . -maxdepth 1 -type f","description":"List files"}',
        toolResult: {
          content: 'Plan mode denies side-effecting tool bash.',
          isError: true,
          errorCode: 'permission_denied',
        },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'I will use a read-only approach instead.',
        timestamp: now,
      },
    ];

    const { container } = renderPane({ messages, isAssistantWorking: true, runMode: 'plan' });

    const summary = screen.getByText(/Ran 1 command.*1 error/);
    const button = summary.closest('button');
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLButtonElement);

    expect(screen.getByText(/find \. -maxdepth 1 -type f/)).toBeTruthy();
    expect(screen.queryByText('Parameters')).toBeNull();
    expect(container.querySelector('.border-l-red-500')).toBeNull();
    expect(screen.queryByRole('button', { name: /permissions\.grant|Grant Bash for this chat/ })).toBeNull();
    expect(screen.getByText(/Plan mode denies side-effecting tool bash/)).toBeTruthy();
  });

  it('preserves an expanded live process row while streamed tool groups grow', () => {
    const now = new Date().toISOString();
    const baseMessages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '检查文件',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect the current file.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/ReadHidden.tsx"}',
      },
    ];
    const { rerender } = renderPane({ messages: baseMessages, isAssistantWorking: true });

    const liveStatus = screen.getByText('Reading ReadHidden.tsx').closest('[role="status"]');
    expect(liveStatus).not.toBeNull();
    if (!liveStatus) throw new Error('Expected live status container');
    const expandButton = liveStatus.querySelector('button');
    expect(expandButton).not.toBeNull();
    fireEvent.click(expandButton as HTMLButtonElement);
    expect(expandButton?.getAttribute('aria-expanded')).toBe('true');

    const nextMessages: ChatMessage[] = [
      ...baseMessages,
      {
        id: 'tool-grep-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Grep',
        toolId: 'tool-grep-1',
        toolInput: '{"pattern":"Footer"}',
      },
    ];
    rerender(createPaneElement({ messages: nextMessages, isAssistantWorking: true }));

    const updatedStatus = screen.getByText('Searching Footer').closest('[role="status"]');
    expect(updatedStatus).not.toBeNull();
    const updatedButton = updatedStatus?.querySelector('button');
    expect(updatedButton?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('ReadHidden.tsx')).toBeTruthy();
  });

  it('collapses a process row when a live turn completes', () => {
    const now = new Date().toISOString();
    const baseMessages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '检查文件',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect first.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/ReadHidden.tsx"}',
      },
    ];
    const { rerender } = renderPane({ messages: baseMessages, isAssistantWorking: true });

    const liveStatus = screen.getByText('Reading ReadHidden.tsx').closest('[role="status"]');
    expect(liveStatus).not.toBeNull();
    if (!liveStatus) throw new Error('Expected live status container');
    const expandButton = liveStatus.querySelector('button');
    expect(expandButton).not.toBeNull();
    fireEvent.click(expandButton as HTMLButtonElement);
    expect(expandButton?.getAttribute('aria-expanded')).toBe('true');

    const completedMessages: ChatMessage[] = [
      {
        ...baseMessages[0],
      },
      {
        ...baseMessages[1],
      },
      {
        ...baseMessages[2],
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Done.',
        timestamp: now,
      },
    ];
    rerender(createPaneElement({ messages: completedMessages }));

    const summary = screen.getByText('Explored 1 file');
    const completedButton = summary.closest('button');
    expect(completedButton?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ReadHidden.tsx')).toBeNull();
  });

  it('does not search hidden completed process detail content', async () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '检查文件',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/SearchHiddenNeedle.tsx"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'Done.',
        timestamp: now,
      },
      {
        id: 'u-2',
        type: 'user',
        content: '下一个问题',
        timestamp: now,
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Ready.',
        timestamp: now,
      },
    ];

    renderPane({ messages });

    const summary = screen.getByText('Explored 1 file');
    const processButton = summary.closest('button');
    expect(processButton?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('SearchHiddenNeedle.tsx')).toBeNull();

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const search = screen.getByRole('search');
    const input = search.querySelector('input[type="search"]') as HTMLInputElement | null;
    if (!input) throw new Error('Expected chat search input');
    fireEvent.change(input, { target: { value: 'SearchHiddenNeedle.tsx' } });

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Previous match' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: 'Next match' }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(processButton?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('mark.chat-history-search-highlight-active')).toBeNull();
  });

  it('does not capture the find shortcut from an active file search surface', () => {
    renderPane({ messages: [makeMessage(0)] });
    const fileSurface = document.createElement('div');
    fileSurface.dataset.fileSearchSurface = '';
    const fileInput = document.createElement('input');
    fileSurface.append(fileInput);
    document.body.append(fileSurface);

    fireEvent.keyDown(fileInput, { key: 'f', ctrlKey: true });

    expect(screen.queryByRole('search')).toBeNull();
    fileSurface.remove();
  });

  it('moves between mounted search results without resetting the conversation scroll position', async () => {
    const messages: ChatMessage[] = [
      {
        id: 'u-search-1',
        type: 'user',
        content: 'First visible needle',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'a-search-2',
        type: 'assistant',
        content: 'Second visible needle',
        timestamp: new Date().toISOString(),
      },
    ];

    renderPane({ messages });

    const messageList = screen.getByText('First visible needle').closest('[data-total-message-count]');
    const scrollContainer = messageList?.parentElement as HTMLElement | null;
    if (!scrollContainer) throw new Error('Expected conversation scroll container');

    let currentScrollTop = 240;
    const setScrollTop = vi.fn((value: number) => {
      currentScrollTop = value;
    });
    const scrollTo = vi.fn();
    Object.defineProperty(scrollContainer, 'scrollTop', {
      configurable: true,
      get: () => currentScrollTop,
      set: setScrollTop,
    });
    Object.defineProperty(scrollContainer, 'clientHeight', {
      configurable: true,
      value: 400,
    });
    scrollContainer.scrollTo = scrollTo;

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const searchInput = screen.getByRole('search').querySelector('input[type="search"]');
    if (!(searchInput instanceof HTMLInputElement)) throw new Error('Expected chat search input');
    fireEvent.change(searchInput, { target: { value: 'needle' } });

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalled();
      expect(document.querySelectorAll('mark.chat-history-search-highlight')).toHaveLength(2);
      expect(document.querySelectorAll('mark.chat-history-search-highlight-active')).toHaveLength(1);
    });
    expect(
      document.querySelector('mark.chat-history-search-highlight-active')?.closest('[data-message-key]')
        ?.getAttribute('data-message-key'),
    ).toContain('u-search-1');
    scrollTo.mockClear();
    setScrollTop.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({
      behavior: 'smooth',
    })));
    expect(document.querySelectorAll('mark.chat-history-search-highlight')).toHaveLength(2);
    expect(
      document.querySelector('mark.chat-history-search-highlight-active')?.closest('[data-message-key]')
        ?.getAttribute('data-message-key'),
    ).toContain('a-search-2');
    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it('keeps separated live process rows at the positions where they happened', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续检查',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect files first.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/FirstHidden.tsx"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Now I will verify the build.',
        timestamp: now,
      },
      {
        id: 'tool-bash-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Bash',
        toolId: 'tool-bash-1',
        toolInput: '{"command":"npm run build"}',
      },
    ];

    renderPane({ messages, isAssistantWorking: true });

    const firstAssistant = screen.getByText('I will inspect files first.');
    const firstStatus = screen.getByText('Explored 1 file');
    const secondAssistant = screen.getByText('Now I will verify the build.');
    const runningStatus = screen.getByText('Running npm run build');

    expect(Boolean(firstAssistant.compareDocumentPosition(firstStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(firstStatus.compareDocumentPosition(secondAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(secondAssistant.compareDocumentPosition(runningStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    expect(screen.queryByText('FirstHidden.tsx')).toBeNull();
    const firstStatusContainer = firstStatus.closest('[role="status"]');
    expect(firstStatusContainer).not.toBeNull();
    if (!firstStatusContainer) throw new Error('Expected first inline status container');
    expect(firstStatusContainer.parentElement?.className).toContain('mt-2');
    expect(firstStatusContainer.parentElement?.className).toContain('gap-2');
    const expandButton = firstStatusContainer.querySelector('button');
    expect(expandButton).not.toBeNull();

    fireEvent.click(expandButton as HTMLButtonElement);

    expect(screen.getByText('FirstHidden.tsx')).toBeTruthy();
    expect(firstAssistant.closest('.chat-message')?.className).toContain('pb-2');
  });

  it('keeps completed process rows in their original positions after the turn finishes', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续优化',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect first.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/FirstHidden.tsx"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Now I will run checks.',
        timestamp: now,
      },
      {
        id: 'tool-bash-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Bash',
        toolId: 'tool-bash-1',
        toolInput: '{"command":"npm test"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-3',
        type: 'assistant',
        content: 'All done.',
        timestamp: now,
      },
    ];

    renderPane({ messages });

    const firstAssistant = screen.getByText('I will inspect first.');
    const readSummary = screen.getByText('Explored 1 file');
    const secondAssistant = screen.getByText('Now I will run checks.');
    const commandSummary = screen.getByText('Ran 1 command');
    const finalAssistant = screen.getByText('All done.');

    expect(Boolean(firstAssistant.compareDocumentPosition(readSummary) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(readSummary.compareDocumentPosition(secondAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(secondAssistant.compareDocumentPosition(commandSummary) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(commandSummary.compareDocumentPosition(finalAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('shows generating status after a closed live tool group while the assistant continues', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续优化',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I inspected the file.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/ClosedTool.tsx"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Now I am writing the response.',
        timestamp: now,
      },
    ];
    const activityMessages: ChatMessage[] = [
      {
        id: 'activity-1',
        type: 'system',
        content: 'Reading file',
        timestamp: now,
        isAgentActivity: true,
        activityId: 'activity-1',
        phase: 'tool',
        state: 'completed',
        title: 'Reading file',
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    expect(screen.getByText('Explored 1 file')).toBeTruthy();
    expect(screen.getByText('Generating response')).toBeTruthy();
    expect(screen.queryByText('Reading file')).toBeNull();
  });

  it('folds ordinary failed tools into a compact process row with error count', () => {
    const now = new Date().toISOString();
    const failedResult = {
      content: '<tool_use_error>InputValidationError: missing file_path</tool_use_error>',
      isError: true,
      errorCode: 'tool_execution_failed',
    };
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '修一下页面',
        timestamp: now,
      },
      {
        id: 'tool-edit-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'write_file',
        toolId: 'tool-edit-1',
        toolInput: '{"file_path":"src/FailedTool.tsx","content":"export const failed = true;"}',
        toolResult: failedResult,
      },
      {
        id: 'tool-grep-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Grep',
        toolId: 'tool-grep-1',
        toolInput: '{"pattern":"Footer"}',
        toolResult: failedResult,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will retry with corrected inputs.',
        timestamp: now,
      },
      {
        id: 'u-2',
        type: 'user',
        content: '继续',
        timestamp: now,
      },
    ];

    const { container } = renderPane({ messages });

    expect(screen.queryByText('Tool error')).toBeNull();
    expect(screen.queryByText('FailedTool.tsx')).toBeNull();

    const summary = screen.getByText(/Edited 1 file.*Searched 1 time.*2 errors/);
    const button = summary.closest('button');
    expect(button).not.toBeNull();
    expect(button?.className).toContain('inline-flex');
    expect(button?.className).toContain('items-center');
    expect(button?.className).toContain('text-[14px]');
    expect(button?.className).toContain('leading-relaxed');
    expect(button?.closest('.process-trace')?.className).not.toContain('my-');

    fireEvent.click(button as HTMLButtonElement);

    expect(screen.getByText('FailedTool.tsx')).toBeTruthy();
    expect(container.querySelector('.border-l-red-500')).toBeNull();
  });

  it('shows a waiting status below an in-progress web_fetch in plan mode', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '搜索一下',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: '我去查一下文档。',
        timestamp: now,
      },
      {
        id: 'tool-fetch-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'web_fetch',
        toolId: 'tool-fetch-1',
        toolInput: '{"url":"https://example.com"}',
      },
    ];

    renderPane({ messages, isAssistantWorking: true, runMode: 'plan', planModeActive: true });

    expect(screen.getByText('Fetching web content...')).toBeTruthy();
  });

  it('does not show the web_fetch waiting status in agent mode', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '搜索一下',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: '我去查一下文档。',
        timestamp: now,
      },
      {
        id: 'tool-fetch-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'web_fetch',
        toolId: 'tool-fetch-1',
        toolInput: '{"url":"https://example.com"}',
      },
    ];

    renderPane({ messages, isAssistantWorking: true, runMode: 'agent' });

    expect(screen.queryByText('Fetching web content...')).toBeNull();
  });

  it('does not render a completed compact boundary as a plan-mode process row', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '先规划一下',
        timestamp: now,
      },
      {
        id: 'compact-1',
        type: 'system',
        content: 'Context compacted',
        timestamp: now,
        isCompactBoundary: true,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will make a plan first.',
        timestamp: now,
      },
    ];

    renderPane({ messages, isAssistantWorking: true, runMode: 'plan', planModeActive: true });

    expect(screen.getByText('I will make a plan first.')).toBeTruthy();
    expect(screen.queryByText('Compacted context')).toBeNull();
  });

  it('uses compact message spacing instead of the old large row gap', () => {
    const messages = [
      {
        id: 'u-1',
        type: 'user',
        content: '调整一下',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'First assistant line.',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Second assistant line.',
        timestamp: new Date().toISOString(),
      },
    ];

    renderPane({ messages });

    const firstAssistant = screen.getByText('First assistant line.').closest('.chat-message');
    const secondAssistant = screen.getByText('Second assistant line.').closest('.chat-message');

    expect(firstAssistant?.className).toContain('pb-4');
    expect(firstAssistant?.className).not.toContain('pb-8');
    expect(firstAssistant?.className).toContain('pd-assistant-turn-start');
    expect(secondAssistant?.className).toContain('pd-assistant-turn-end');
  });
});
