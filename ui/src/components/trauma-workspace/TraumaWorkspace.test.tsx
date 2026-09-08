// @vitest-environment jsdom
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
    expect(screen.getByRole('form', { name: '本轮伤情录入' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '提交本轮信息' })).not.toBeNull();
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

  it('preserves form input until a persisted case version appears', async () => {
    caseStoreMock.current = initialUiCaseState();
    const submit = vi.fn();
    const props = {
      resetKey: 'trauma:persisted-reset',
      onSubmitForm: submit,
    };
    const { rerender } = render(<TraumaWorkspace {...props} />);

    fireEvent.change(screen.getByLabelText('伤情描述'), {
      target: { value: '等待持久化后清空' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交本轮信息' }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(caseStoreMock.refresh).not.toHaveBeenCalled();
    expect((screen.getByLabelText('伤情描述') as HTMLTextAreaElement).value)
      .toBe('等待持久化后清空');

    rerender(<TraumaWorkspace {...props} />);
    expect((screen.getByLabelText('伤情描述') as HTMLTextAreaElement).value)
      .toBe('等待持久化后清空');

    caseStoreMock.current = {
      ...caseStoreMock.current,
      version: 2,
      round: 2,
    };
    rerender(<TraumaWorkspace {...props} />);
    expect((screen.getByLabelText('伤情描述') as HTMLTextAreaElement).value).toBe('');
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
