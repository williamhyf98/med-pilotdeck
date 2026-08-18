import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MedTraumaPage from './MedTraumaPage';

const apiMocks = vi.hoisted(() => ({
  loadIndex: vi.fn(),
  loadCase: vi.fn(),
  probe: vi.fn(),
  stream: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../shared/useMedicalModels', () => ({
  useMedicalModels: () => ({
    options: [{ value: '', label: '跟随 PilotDeck 默认路由' }],
    selectedModel: '',
    selectedLabel: '跟随 PilotDeck 默认路由',
    setSelectedModel: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock('./traumaApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('./traumaApi')>();
  return {
    ...original,
    loadTraumaDemoIndex: apiMocks.loadIndex,
    loadTraumaDemoCase: apiMocks.loadCase,
    probeTraumaModel: apiMocks.probe,
    streamTraumaAnalysis: apiMocks.stream,
    stopTraumaAnalysis: apiMocks.stop,
  };
});

describe('MedTraumaPage native workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.stop.mockResolvedValue(undefined);
    localStorage.clear();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:trauma-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(cleanup);

  it('recreates the legacy landing hierarchy as a full-page native surface', () => {
    render(<MedTraumaPage onOpenDialogue={vi.fn()} />);

    const page = screen.getByTestId('medical-trauma-page');
    expect(page.parentElement).toBe(document.body);
    expect(screen.getByRole('heading', {
      name: '您好，我是九格创伤辅助救治助手',
    })).toBeTruthy();
    expect(screen.getByText('九格创伤救治助手')).toBeTruthy();
    expect(screen.getByRole('button', { name: '医学辅助对话助手' })).toBeTruthy();

    expect(screen.getAllByRole('button', { name: /伤员发生地|野战分类场|收容处置组|重伤救治组|手术组|洗消组/u }))
      .toHaveLength(6);
    expect(page.querySelectorAll('.mt-flow-step')).toHaveLength(4);
    expect(screen.getByText('战现场急救')).toBeTruthy();
    expect(screen.getByText('康复治疗')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '手术组' }));
    expect(page.querySelector('[aria-current="step"]')?.textContent).toContain('早期救治');

    fireEvent.click(screen.getByRole('button', { name: '指挥台' }));
    expect(page.getAttribute('data-skin')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: '查看完整流程' }));
    expect(screen.getByText(/功能测定、物理治疗/u)).toBeTruthy();
  });

  it('keeps image categories, labels, and ordering editable', () => {
    render(<MedTraumaPage onOpenDialogue={vi.fn()} />);

    const files = [
      new File(['first'], 'first.png', { type: 'image/png' }),
      new File(['second'], 'second.png', { type: 'image/png' }),
    ];
    fireEvent.change(screen.getByLabelText('上传影像文件'), {
      target: { files },
    });

    let labels = screen.getAllByRole('textbox', { name: /图像标签/u });
    expect(labels.map((input) => (input as HTMLInputElement).value)).toEqual([
      'first.png',
      'second.png',
    ]);
    const firstCategory = screen.getByRole('combobox', {
      name: '图像类别 first.png',
    }) as HTMLSelectElement;
    expect(firstCategory.value).toBe('wound');
    fireEvent.change(firstCategory, { target: { value: 'ecg' } });
    expect(firstCategory.value).toBe('ecg');

    fireEvent.click(screen.getByRole('button', { name: '上移 second.png' }));
    labels = screen.getAllByRole('textbox', { name: /图像标签/u });
    expect(labels.map((input) => (input as HTMLInputElement).value)).toEqual([
      'second.png',
      'first.png',
    ]);

    fireEvent.change(screen.getByRole('textbox', { name: '图像标签 second.png' }), {
      target: { value: '床旁监护心电' },
    });
    expect((screen.getByDisplayValue('床旁监护心电') as HTMLInputElement).value)
      .toBe('床旁监护心电');
  });

  it('loads the real demo index and marks a historical static evaluation', async () => {
    apiMocks.loadIndex.mockResolvedValue([
      { id: 'case-1', title: '开放伤案例', historicalEvaluation: true },
    ]);
    apiMocks.loadCase.mockResolvedValue({
      id: 'case-1',
      title: '开放伤案例',
      description: '后端案例描述',
      stage: 'field-triage',
      historicalEvaluation: true,
      images: [{
        id: 'img-1',
        image_id: 'img-1',
        name: '伤口图',
        label: '正面伤口',
        category: 'wound',
        index: 0,
        demo: true,
      }],
      results: {
        imaging: '影像结论',
        'stage-action': '阶段动作',
        'specific-action': '专项动作',
        evacuation: '后送建议',
        safety: '安全边界',
      },
    });
    render(<MedTraumaPage onOpenDialogue={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '更多研判工具' }));
    fireEvent.click(screen.getByRole('button', { name: '获取演示索引' }));
    await screen.findByRole('combobox', { name: '演示案例' });
    fireEvent.click(screen.getByRole('button', { name: '载入所选案例' }));

    expect(await screen.findByText('影像结论')).toBeTruthy();
    expect(screen.getByText('历史静态评测')).toBeTruthy();
    expect(apiMocks.loadIndex).toHaveBeenCalledOnce();
    expect(apiMocks.loadCase).toHaveBeenCalledWith('case-1');
  });

  it('reports demo backend failure without substituting a built-in case', async () => {
    apiMocks.loadIndex.mockRejectedValue(new Error('演示后端未就绪'));
    render(<MedTraumaPage onOpenDialogue={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '更多研判工具' }));
    fireEvent.click(screen.getByRole('button', { name: '获取演示索引' }));

    expect(await screen.findByText('演示后端未就绪')).toBeTruthy();
    expect(screen.queryByText('演示资料已就绪')).toBeNull();
  });

  it('supports model probing and eval/plain mode selection', async () => {
    apiMocks.probe.mockResolvedValue('模型可用');
    render(<MedTraumaPage onOpenDialogue={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '更多研判工具' }));
    fireEvent.click(screen.getByRole('button', { name: '模型探活' }));
    expect(await screen.findByRole('button', { name: '模型在线' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '普通模式' }));
    fireEvent.change(screen.getByPlaceholderText(/伤员意识/u), {
      target: { value: '测试伤情描述' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始研判' }));
    await waitFor(() => expect(apiMocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'plain' }),
    ));
  });

  it('aborts an active stream and asks the backend to stop its session', async () => {
    apiMocks.stream.mockImplementation(async ({ onEvent }) => {
      onEvent({
        event: 'delta',
        data: { sessionId: 'session-1', text: '一、图像研判\n片段' },
      });
      await new Promise(() => undefined);
    });
    render(<MedTraumaPage onOpenDialogue={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/伤员意识/u), {
      target: { value: '测试停止' },
    });

    fireEvent.click(screen.getByRole('button', { name: '开始研判' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    await waitFor(() => expect(apiMocks.stop).toHaveBeenCalledWith('session-1'));
  });
});
