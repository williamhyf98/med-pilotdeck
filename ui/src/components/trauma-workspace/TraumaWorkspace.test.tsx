// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TraumaWorkspace from './TraumaWorkspace';
import { initialUiCaseState } from './testFixtures';
import { snapshotsToRounds } from './domain/snapshotAdapter';

const caseStoreMock = vi.hoisted(() => ({
  current: null as any,
  snapshots: [] as any[],
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
}));

vi.mock('./store/useCaseStore', () => ({
  useCaseStore: () => caseStoreMock,
}));

afterEach(() => {
  cleanup();
  caseStoreMock.current = null;
  caseStoreMock.snapshots = [];
  caseStoreMock.error = null;
  caseStoreMock.refresh.mockReset();
});

describe('TraumaWorkspace', () => {
  it('injects the trauma composer into a runtime chat panel composer slot', () => {
    function RuntimePanel({ externalComposerSlot }: { externalComposerSlot?: ReactNode }) {
      return (
        <div data-testid="runtime-chat-shell">
          <div>runtime messages</div>
          <div data-testid="runtime-composer-slot">{externalComposerSlot}</div>
        </div>
      );
    }

    render(
      <TraumaWorkspace
        resetKey="trauma:slot"
        onSubmitForm={vi.fn()}
        runtimePanel={<RuntimePanel />}
      />,
    );

    expect(screen.getByText('runtime messages')).not.toBeNull();
    expect(within(screen.getByTestId('runtime-composer-slot')).getByLabelText('本轮伤情自由输入')).not.toBeNull();
  });

  it('renders the focused form and can host the chat surface without the old timeline', () => {
    render(
      <TraumaWorkspace
        resetKey="trauma:empty"
        onSubmitForm={vi.fn()}
        runtimePanel={<div>runtime chat surface</div>}
      />,
    );

    const facilityStatus = screen.getByText('当前位置').parentElement!;
    expect(within(facilityStatus).getByText('未定级')).not.toBeNull();
    expect(screen.getByRole('region', { name: '推演对话' })).not.toBeNull();
    expect(screen.getByText('runtime chat surface')).not.toBeNull();
    // The free-text composer is the primary surface; the manual form is behind the disclosure.
    expect(screen.getByLabelText('本轮伤情自由输入')).not.toBeNull();
    expect(screen.getByRole('button', { name: '整理' })).not.toBeNull();
    expect(screen.queryByPlaceholderText(/发送消息/)).toBeNull();
    expect(screen.queryByRole('button', { name: /沿用/ })).toBeNull();
    expect(screen.queryByLabelText('推演轮次时间线')).toBeNull();
  });

  it('keeps the raw conversation surface mounted while removing the old timeline panel', () => {
    const state = initialUiCaseState();
    state.round = 3;
    caseStoreMock.snapshots = [{
      eventType: 'agent_turn',
      round: 3,
      createdAt: state.updatedAt,
      triggerMessageId: 'message-form',
      state,
      response: {
        naturalLanguageAnswer: '继续观察。',
        treatmentPlan: [],
        placement: { source: 'definition', subStage: 'primary_first_aid' },
        transition: { status: 'STAY', reason: '留在本级' },
      },
    }];

    render(
      <TraumaWorkspace
        resetKey="trauma:exact-form"
        onSubmitForm={vi.fn()}
        runtimePanel={<div>runtime chat surface</div>}
      />,
    );
    expect(screen.getByRole('region', { name: '推演对话' })).not.toBeNull();
    expect(screen.getByText('runtime chat surface')).not.toBeNull();
    expect(screen.queryByLabelText('推演轮次时间线')).toBeNull();
  });

  it('keeps the live conversation area available with the assistant response surface', () => {
    const state = initialUiCaseState();
    state.round = 2;
    state.version = 2;
    state.injuryNarratives = [
      { round: 1, createdAt: state.updatedAt, text: '右小腿开放伤' },
      { round: 2, createdAt: state.updatedAt, text: '胸痛加重' },
    ];
    state.treatmentNarratives = [
      { round: 2, createdAt: state.updatedAt, text: '已加压包扎' },
    ];
    state.evacuationNarratives = [
      { round: 1, createdAt: state.updatedAt, text: '车辆待命' },
    ];
    state.notes = [{ round: 2, createdAt: state.updatedAt, text: '意识清楚' }];
    state.vitalSignsHistory = [
      {
        round: 2,
        recordedAt: state.updatedAt,
        values: { respiratoryRate: 32, systolicBloodPressure: 92 },
      },
    ];
    state.memos = [{
      id: 'memo-live',
      round: 2,
      createdAt: state.updatedAt,
      mainStage: 'battlefield_first_aid',
      subStage: 'advanced_first_aid',
      title: '真实病例',
      inputPoints: [],
      actionPoints: [],
      conclusion: '继续评估',
      snapshotVersion: 2,
    }];
    caseStoreMock.current = state;
    caseStoreMock.snapshots = [{
      eventType: 'agent_turn',
      round: 2,
      createdAt: state.updatedAt,
      triggerMessageId: 'message-2',
      state,
      response: {
        naturalLanguageAnswer: '## 处置建议\n- 继续止血并密切复查循环状态。',
        transition: { status: 'STAY', reason: '留在本级' },
        treatmentPlan: [],
      },
    }];

    render(
      <TraumaWorkspace
        resetKey="trauma:live"
        projectKey="trauma_med-demo"
        sessionId="web:s_live"
        onSubmitForm={vi.fn()}
        runtimePanel={<div>runtime chat surface</div>}
      />,
    );

    expect(screen.getByRole('region', { name: '推演对话' })).not.toBeNull();
    expect(screen.getByText('runtime chat surface')).not.toBeNull();
    expect(screen.queryByLabelText('推演轮次时间线')).toBeNull();
    expect(screen.getByText(/阶段转换建议不会自动执行/)).not.toBeNull();
    expect(screen.queryByText(/阶段转换只有确认/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /R2真实病例/ }));
    expect(screen.getByText('执行状态：')).not.toBeNull();
    expect(screen.queryByText('用户确认：')).toBeNull();
  });

  it('navigates the chat to the matching input bubble when selecting a round memo', () => {
    const state = initialUiCaseState();
    state.round = 2;
    state.version = 2;
    state.memos = [{
      id: 'memo-nav',
      round: 2,
      createdAt: state.updatedAt,
      mainStage: 'battlefield_first_aid',
      subStage: 'primary_first_aid',
      title: '点击定位',
      inputPoints: [],
      actionPoints: [],
      conclusion: '定位到输入',
      snapshotVersion: 2,
    }];
    caseStoreMock.current = state;
    caseStoreMock.snapshots = [{
      eventType: 'agent_turn',
      round: 2,
      createdAt: state.updatedAt,
      triggerMessageId: 'run-nav',
      state,
      response: {
        naturalLanguageAnswer: '继续观察。',
        transition: { status: 'STAY', reason: '留在本级' },
        treatmentPlan: [],
      },
    }];
    const navigate = vi.fn();

    render(
      <TraumaWorkspace
        resetKey="trauma:navigate"
        onSubmitForm={vi.fn()}
        onNavigateToChatMessage={navigate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /R2点击定位/ }));
    expect(navigate).toHaveBeenCalledWith('run-nav');
  });

  it('shows only used evidence and the reduced current status in memo detail', () => {
    const state = initialUiCaseState();
    state.round = 1;
    state.version = 1;
    state.vitalSignsHistory = [{
      round: 1,
      recordedAt: state.updatedAt,
      values: { respiratoryRate: 30 },
    }];
    state.injuryNarratives = [{ round: 1, createdAt: state.updatedAt, text: '右小腿开放伤' }];
    state.treatmentNarratives = [{ round: 1, createdAt: state.updatedAt, text: '已加压包扎' }];
    state.memos = [{
      id: 'memo-detail',
      round: 1,
      createdAt: state.updatedAt,
      mainStage: 'battlefield_first_aid',
      subStage: 'primary_first_aid',
      title: '详情精简',
      inputPoints: [],
      actionPoints: [],
      conclusion: '继续观察',
      snapshotVersion: 1,
    }];
    state.evidence = [
      {
        id: 'used-chunk',
        documentTitle: '已使用条款',
        section: '第二章',
        text: '已使用知识块内容',
        retrievalScore: 0.91,
        retrievalBackend: 'remote',
        usedInAnswer: true,
      },
      {
        id: 'unused-chunk',
        documentTitle: '未使用条款',
        section: '第三章',
        text: '未使用知识块内容',
        retrievalScore: 0.82,
        retrievalBackend: 'local',
        usedInAnswer: false,
      },
    ];
    caseStoreMock.current = state;
    caseStoreMock.snapshots = [{
      eventType: 'agent_turn',
      round: 1,
      createdAt: state.updatedAt,
      triggerMessageId: 'message-detail',
      state,
      response: {
        naturalLanguageAnswer: '继续观察。',
        treatmentPlan: [],
        transition: { status: 'STAY', reason: '留在本级' },
      },
    }];

    render(<TraumaWorkspace resetKey="trauma:detail" onSubmitForm={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /R1详情精简/ }));

    expect(screen.getByText('当前状态')).not.toBeNull();
    expect(screen.queryByText('当前伤员状态')).toBeNull();
    expect(screen.queryByText('意识')).toBeNull();
    expect(screen.queryByText('伤情')).toBeNull();
    expect(screen.queryByText('已实施处置')).toBeNull();
    expect(screen.getByText('知识块依据 · 已使用 1 条')).not.toBeNull();
    expect(screen.getByText('已使用条款')).not.toBeNull();
    expect(screen.queryByText('未使用条款')).toBeNull();
  });

  it('removes injury-count and elapsed-time status assumptions', () => {
    render(<TraumaWorkspace resetKey="trauma:empty" onSubmitForm={vi.fn()} />);

    expect(screen.queryByText(/项伤情记录/)).toBeNull();
    expect(screen.queryByText('伤后时间')).toBeNull();
    expect(screen.queryByText('时效提示')).toBeNull();
    expect(screen.getByText('医务中心')).not.toBeNull();
  });

  it('keeps the realtime runtime mounted and exposes it while submitting', () => {
    const runtime = <div data-testid="trauma-runtime">实时处理与确认</div>;
    const { rerender } = render(
      <TraumaWorkspace
        resetKey="trauma:runtime"
        runtimePanel={runtime}
        onSubmitForm={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: '推演对话' })).not.toBeNull();

    rerender(
      <TraumaWorkspace
        resetKey="trauma:runtime"
        runtimePanel={runtime}
        onSubmitForm={vi.fn()}
        submitting
      />,
    );
    expect(screen.getByText('实时处理与确认')).not.toBeNull();
  });

  it('shows a non-clickable loading leaf while the snapshot is being assembled', () => {
    render(
      <TraumaWorkspace
        resetKey="trauma:pending"
        pendingRun={{
          runId: 'run-pending',
          mainStage: 'battlefield_first_aid',
          subStage: 'primary_first_aid',
          round: 1,
        }}
        onSubmitForm={vi.fn()}
      />,
    );

    const pending = screen.getByTestId('trauma-pending-round');
    expect(within(pending).getByText('R1 生成中')).not.toBeNull();
    expect(within(pending).getByLabelText('生成中')).not.toBeNull();
    expect(within(pending).queryByRole('button')).toBeNull();
  });

  it('highlights the pending target path and marks earlier ancestors complete', () => {
    render(
      <TraumaWorkspace
        resetKey="trauma:pending-target"
        pendingRun={{
          runId: 'run-pending-target',
          mainStage: 'early_treatment',
          subStage: 'emergency_treatment',
          round: 1,
        }}
        onSubmitForm={vi.fn()}
      />,
    );

    const battlefield = screen.getByText('战现场急救').closest('div.rounded-lg') as HTMLElement;
    const earlyTreatment = screen.getByText('早期救治').closest('div.rounded-lg') as HTMLElement;
    expect(within(battlefield).getByText('已完成')).not.toBeNull();
    expect(within(earlyTreatment).getByText('当前')).not.toBeNull();

    const primaryLabel = screen.getAllByText('初级急救').find((element) => element.tagName.toLowerCase() === 'p') as HTMLElement;
    const advancedLabel = screen.getAllByText('高级急救').find((element) => element.tagName.toLowerCase() === 'p') as HTMLElement;
    const emergencyLabel = screen.getAllByText('紧急处置').find((element) => element.tagName.toLowerCase() === 'p') as HTMLElement;
    const primary = primaryLabel.closest('div.rounded-md') as HTMLElement;
    const advanced = advancedLabel.closest('div.rounded-md') as HTMLElement;
    const emergency = emergencyLabel.closest('div.rounded-md') as HTMLElement;
    expect(within(primary).getByText('已完成')).not.toBeNull();
    expect(within(advanced).getByText('已完成')).not.toBeNull();
    expect(within(emergency).getByText('当前')).not.toBeNull();
    expect(screen.getByTestId('trauma-pending-round')).not.toBeNull();
  });

  it('shows no loading leaf until the level is confirmed', () => {
    // 级别未定时不猜位置——以前会兜底挂到「初级急救」下，等级别确认后再跳走。
    render(
      <TraumaWorkspace
        resetKey="trauma:pending-unplaced"
        pendingRun={{ runId: 'run-unplaced', round: 1 }}
        onSubmitForm={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('trauma-pending-round')).toBeNull();
    const primaryLabel = screen.getAllByText('初级急救').find((element) => element.tagName.toLowerCase() === 'p') as HTMLElement;
    const primary = primaryLabel.closest('div.rounded-md') as HTMLElement;
    expect(within(primary).getByText('未开始')).not.toBeNull();
  });

  it('opens the newly persisted memo and replaces the loading leaf', async () => {
    const pendingRun = {
      runId: 'run-complete',
      mainStage: 'battlefield_first_aid',
      subStage: 'advanced_first_aid',
      round: 2,
    };
    const { rerender } = render(
      <TraumaWorkspace
        resetKey="trauma:pending-complete"
        pendingRun={pendingRun}
        onSubmitForm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('trauma-pending-round')).not.toBeNull();

    const state = {
      ...initialUiCaseState(),
      version: 2,
      round: 2,
      currentSubStage: 'advanced_first_aid' as const,
      memos: [{
        id: 'memo-complete',
        round: 2,
        createdAt: '2026-09-03T15:10:00+08:00',
        mainStage: 'battlefield_first_aid' as const,
        subStage: 'advanced_first_aid' as const,
        title: '真实快照',
        inputPoints: ['胸痛加重'],
        actionPoints: ['持续监测'],
        conclusion: '继续观察',
        snapshotVersion: 2,
      }],
    };
    caseStoreMock.current = state;
    caseStoreMock.snapshots = [{
      eventType: 'agent_turn',
      round: 2,
      createdAt: state.updatedAt,
      triggerMessageId: pendingRun.runId,
      state,
      response: {
        naturalLanguageAnswer: '继续观察。',
        treatmentPlan: [],
        transition: { status: 'STAY', reason: '留在本级' },
      },
    }];
    rerender(
      <TraumaWorkspace
        resetKey="trauma:pending-complete"
        pendingRun={pendingRun}
        onSubmitForm={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('trauma-pending-round')).toBeNull();
      expect(screen.getByLabelText('轮次纪要详情')).not.toBeNull();
      expect(screen.getAllByText('真实快照').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('preserves form input across a case persistence and a version bump', async () => {
    const submit = vi.fn();
    const props = {
      resetKey: 'trauma:persisted-reset',
      onSubmitForm: submit,
    };
    // Mount onto an already-persisted case (v1) so the composer key is stable.
    caseStoreMock.current = { ...initialUiCaseState(), version: 1, round: 1 };
    const { rerender } = render(<TraumaWorkspace {...props} />);

    fireEvent.change(screen.getByLabelText('本轮伤情自由输入'), {
      target: { value: '等待持久化后清空' },
    });

    // A new persisted version for the same case must NOT clear the draft;
    // the composer is keyed by caseId, so a live refresh keeps user input.
    caseStoreMock.current = { ...initialUiCaseState(), version: 2, round: 2 };
    rerender(<TraumaWorkspace {...props} />);
    expect((screen.getByLabelText('本轮伤情自由输入') as HTMLTextAreaElement).value)
      .toBe('等待持久化后清空');

    // Switching to a different case (new resetKey) remounts and clears it.
    caseStoreMock.current = { ...initialUiCaseState(), caseId: 'case-other', version: 1, round: 1 };
    rerender(<TraumaWorkspace {...props} resetKey="trauma:other" />);
    expect((screen.getByLabelText('本轮伤情自由输入') as HTMLTextAreaElement).value).toBe('');
  });

  it('describes READY as advice without implying a second confirmation', () => {
    const state = initialUiCaseState();
    state.transport.gateStatus = 'READY';
    state.memos = [{
      id: 'memo-ready',
      round: 1,
      createdAt: state.updatedAt,
      mainStage: 'battlefield_first_aid',
      subStage: 'primary_first_aid',
      title: '建议后送',
      inputPoints: [],
      actionPoints: [],
      conclusion: '建议转级',
      snapshotVersion: 1,
    }];
    const [round] = snapshotsToRounds([{
      eventType: 'agent_turn',
      round: 1,
      createdAt: state.updatedAt,
      triggerMessageId: 'message-ready',
      state,
      response: {
        naturalLanguageAnswer: '建议转送。',
        treatmentPlan: [],
        transition: { status: 'READY', reason: '需要更高能力' },
      },
    }], state);

    expect(round?.gate.confirmation).toBe('医学建议，未自动执行');
  });
});
