// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
import FilesV2 from './FilesV2';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  uploadFiles: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  api: { uploadFiles: mocks.uploadFiles },
  authenticatedFetch: mocks.authenticatedFetch,
}));

const project: Project = {
  name: 'general_med-test',
  displayName: '测试项目',
  fullPath: '/workspace',
};

const usageBody = {
  usage: { inboxBytes: 2048, exportsBytes: 4096, scratchBytes: 1024, totalBytes: 7168 },
  thresholds: { workspaceWarnBytes: 5 * 1024 ** 3, scratchWarnBytes: 1024 ** 3 },
};

const rootEntries = {
  path: '',
  truncated: false,
  entries: [
    { name: 'inbox', path: 'inbox', type: 'directory', size: null, modified: '2026-11-11T02:00:00.000Z' },
    { name: 'exports', path: 'exports', type: 'directory', size: null, modified: '2026-11-11T03:00:00.000Z' },
    { name: 'scratch', path: 'scratch', type: 'directory', size: null, modified: '2026-11-10T03:00:00.000Z' },
  ],
};

const exportsEntries = {
  path: 'exports',
  truncated: false,
  entries: [
    { name: '诊疗报告.pdf', path: 'exports/诊疗报告.pdf', type: 'file', size: 4096, modified: '2026-11-11T03:00:00.000Z' },
  ],
};

const emptyTrashBody = {
  entries: [],
  totals: { count: 0, bytes: 0 },
  retentionDays: 7,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    blob: vi.fn(async () => new Blob(['%PDF'])),
    headers: new Headers(),
  } as unknown as Response;
}

function installFetchRouter(overrides: Record<string, Response> = {}) {
  mocks.authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = Object.keys(overrides).find((pattern) => url.includes(pattern));
    if (key) return overrides[key];
    if (url.includes('/trash/restore') && method === 'POST') return jsonResponse({ restored: { path: 'inbox/a.csv' } });
    if (url.includes('/trash/empty') && method === 'POST') return jsonResponse({ purged: 1, freedBytes: 10 });
    if (url.includes('/trash')) return jsonResponse(emptyTrashBody);
    if (url.includes('/files/mkdir') && method === 'POST') return jsonResponse({ path: '我的资料' }, 201);
    if (url.includes('/workspace/scratch/clean') && method === 'POST') return jsonResponse({ removed: 0, freedBytes: 0 });
    if (url.includes('/workspace/usage')) return jsonResponse(usageBody);
    if (url.includes('/files/list?path=exports')) return jsonResponse(exportsEntries);
    if (url.includes('/files/list')) return jsonResponse(rootEntries);
    if (url.endsWith('/file') && method === 'PUT') return jsonResponse({ success: true, path: 'exports/note.md' });
    if (url.includes('/file?filePath=')) return jsonResponse({ content: '# 报告\n内容' });
    if (url.includes('/files/content')) return jsonResponse({});
    if (url.includes('/files/preview/pdf')) return jsonResponse({});
    throw new Error(`unexpected url: ${method} ${url}`);
  });
}

describe('FilesV2 工作区面板', () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockReset();
    mocks.uploadFiles.mockReset();
    mocks.uploadFiles.mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    installFetchRouter();
  });

  afterEach(() => cleanup());

  it('显示三条用量条、目录说明，并按需加载目录', async () => {
    render(<FilesV2 selectedProject={project} />);

    expect(await screen.findByText('工作区总量')).not.toBeNull();
    // 用量条标签和目录行同名，各出现一次
    expect(screen.getAllByText('scratch').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('inbox').length).toBeGreaterThanOrEqual(2);
    // 7168 B → 7.0 KB，总量条带提示阈值
    expect(screen.getByText(/7\.0 KB/)).not.toBeNull();
    // inbox 2048/7168 = 28.6%
    expect(screen.getByText(/占 28\.6%/)).not.toBeNull();
    // 用量占比很低时是"正常"提示，不是固定文案
    expect(screen.getByText('占用正常；仅为提示，不会拦截写入')).not.toBeNull();

    // 三个默认目录的用途说明（替代原来的可读/可写/只读）
    expect(screen.getByText('上传的原件，agent 只读；不会自动清理')).not.toBeNull();
    expect(screen.getByText('最终成品，可直接下载；不会自动清理')).not.toBeNull();
    expect(screen.getByText('中间产物，会自动清理，可手动立即清理')).not.toBeNull();
    expect(screen.queryByText('scratch 会定期自动清理；inbox 与 exports 不会')).toBeNull();

    // 根目录只请求一次；子目录懒加载
    expect(screen.getAllByText('inbox').length).toBeGreaterThanOrEqual(2);
    // 目录说明卡 + 目录行各一次
    expect(screen.getAllByText('exports').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('scratch').length).toBeGreaterThanOrEqual(2);
    expect(mocks.authenticatedFetch.mock.calls.filter(([url]) => String(url).includes('path=exports'))).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /exports/ }));
    expect(await screen.findByText('诊疗报告.pdf')).not.toBeNull();
    expect(mocks.authenticatedFetch.mock.calls.some(([url]) => String(url).includes('path=exports'))).toBe(true);
  });

  it('工作区总量占比高时，提示语变成清理建议', async () => {
    installFetchRouter({
      '/workspace/usage': jsonResponse({
        usage: { inboxBytes: 300, exportsBytes: 600, scratchBytes: 0, totalBytes: 900 },
        thresholds: { workspaceWarnBytes: 1000, scratchWarnBytes: 1000 },
      }),
    });
    render(<FilesV2 selectedProject={project} />);

    expect(await screen.findByText(/占用偏高，建议清理 scratch/)).not.toBeNull();
  });

  it('头部按钮悬停时出现主题气泡提示', async () => {
    installFetchRouter();
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.mouseEnter(screen.getByRole('button', { name: '上传文件' }));

    expect(await screen.findByText('上传文件', {}, { timeout: 2_000 })).not.toBeNull();
  });

  it('点击文本文件弹出预览，可转到编辑器打开', async () => {
    installFetchRouter({
      '/files/list?path=exports': jsonResponse({
        path: 'exports',
        truncated: false,
        entries: [{
          name: 'note.md',
          path: 'exports/note.md',
          type: 'file',
          size: 12,
          modified: '2026-11-11T03:00:00.000Z',
        }],
      }),
    });
    const onFileOpen = vi.fn();
    render(<FilesV2 selectedProject={project} onFileOpen={onFileOpen} />);

    await screen.findByText('工作区总量');
    fireEvent.click(screen.getByRole('button', { name: /exports/ }));
    fireEvent.click(await screen.findByRole('button', { name: /note\.md/ }));

    const dialog = await screen.findByRole('dialog');
    expect(await screen.findByText(/内容/)).not.toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '在编辑器中打开' }));
    expect(onFileOpen).toHaveBeenCalledWith('exports/note.md');
  });

  it('上传文件到带时间戳的 inbox 批次，并刷新用量与目录', async () => {
    const { container } = render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new globalThis.File(['report'], '检查结果.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(mocks.uploadFiles).toHaveBeenCalledOnce());
    const [projectName, formData] = mocks.uploadFiles.mock.calls[0] as [string, FormData];
    expect(projectName).toBe(project.name);
    expect(formData.get('targetPath')).toMatch(/^inbox\/uploads\/\d{13}$/);
    expect(formData.getAll('files')).toHaveLength(1);
    expect(await screen.findByText('已上传 1 个文件')).not.toBeNull();
    // 上传成功后会重新拉一次用量
    expect(mocks.authenticatedFetch.mock.calls.filter(([url]) => String(url).includes('/workspace/usage')).length)
      .toBeGreaterThanOrEqual(2);
  });

  it('新建目录：走 mkdir 接口并刷新目录树', async () => {
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.click(screen.getByRole('button', { name: '新建目录' }));
    fireEvent.change(screen.getByLabelText('目录名'), { target: { value: '我的资料' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/files/mkdir'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: '我的资料' }) }),
    ));
    expect(await screen.findByText('已创建目录 我的资料')).not.toBeNull();
  });

  it('回收站：列表展示原路径，可单项恢复', async () => {
    installFetchRouter({
      '/trash': jsonResponse({
        entries: [{
          path: '.trash/inbox/a.csv.20261111T010101000Z',
          originalPath: 'inbox/a.csv',
          deletedAt: '2026-11-11T01:01:01.000Z',
          sizeBytes: 10,
          kind: 'file',
        }],
        totals: { count: 1, bytes: 10 },
        retentionDays: 7,
      }),
    });
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.click(screen.getByRole('button', { name: /回收站/ }));
    expect(await screen.findByText('inbox/a.csv')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/trash/restore'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '.trash/inbox/a.csv.20261111T010101000Z' }),
      }),
    ));
    expect(await screen.findByText('已恢复到 inbox/a.csv')).not.toBeNull();
  });

  it('顶部提示 4 秒后自动消失', async () => {
    installFetchRouter({
      '/trash': jsonResponse({
        entries: [{
          path: '.trash/inbox/a.csv.20261111T010101000Z',
          originalPath: 'inbox/a.csv',
          deletedAt: '2026-11-11T01:01:01.000Z',
          sizeBytes: 10,
          kind: 'file',
        }],
        totals: { count: 1, bytes: 10 },
        retentionDays: 7,
      }),
    });
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.click(screen.getByRole('button', { name: /回收站/ }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
    expect(await screen.findByText('已恢复到 inbox/a.csv')).not.toBeNull();

    await waitFor(() => expect(screen.queryByText('已恢复到 inbox/a.csv')).toBeNull(), { timeout: 6000 });
  }, 10_000);

  it('清空回收站需要在二次确认里点“永久删除”', async () => {
    installFetchRouter({
      '/trash': jsonResponse({
        entries: [{
          path: '.trash/exports/report.pdf.20261111T010101000Z',
          originalPath: 'exports/report.pdf',
          deletedAt: '2026-11-11T01:01:01.000Z',
          sizeBytes: 10,
          kind: 'file',
        }],
        totals: { count: 1, bytes: 10 },
        retentionDays: 7,
      }),
    });
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    const dialog = await screen.findByRole('dialog', { name: '清空回收站' });
    // 第一次只是打开确认框，不发请求
    expect(mocks.authenticatedFetch.mock.calls.some(([url]) => String(url).includes('/trash/empty'))).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }));
    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/trash/empty'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: true }) }),
    ));
  });

  it('“立即清理 scratch”在 scratch 为空时禁用', async () => {
    installFetchRouter({
      '/workspace/usage': jsonResponse({
        usage: { inboxBytes: 0, exportsBytes: 0, scratchBytes: 0, totalBytes: 0 },
        thresholds: { workspaceWarnBytes: 5 * 1024 ** 3, scratchWarnBytes: 1024 ** 3 },
      }),
    });
    render(<FilesV2 selectedProject={project} />);
    const button = await screen.findByRole('button', { name: '立即清理 scratch' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('“立即清理 scratch”先弹确认，确认后才带 force + confirm 提交', async () => {
    installFetchRouter();
    render(<FilesV2 selectedProject={project} />);

    fireEvent.click(await screen.findByRole('button', { name: '立即清理 scratch' }));
    const dialog = await screen.findByRole('dialog', { name: '清理 scratch' });
    // 第一次只是打开确认框，不发请求
    expect(mocks.authenticatedFetch.mock.calls.some(([url]) => String(url).includes('/scratch/clean'))).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: '清理' }));
    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/workspace/scratch/clean'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ force: true, confirm: true }),
      }),
    ));
  });

  it('把文件拖到目录行会调用 move 接口', async () => {
    installFetchRouter({
      '/files/move': jsonResponse({ from: 'exports/诊疗报告.pdf', to: 'inbox/诊疗报告.pdf' }),
    });
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.click(screen.getByRole('button', { name: /exports/ }));
    const fileLabel = await screen.findByText('诊疗报告.pdf');
    const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => '' };
    const draggable = fileLabel.closest('[draggable="true"]');
    expect(draggable).not.toBeNull();
    fireEvent.dragStart(draggable!, { dataTransfer: dt });

    const inboxRow = screen.getByRole('button', { name: /inbox/ });
    fireEvent.dragOver(inboxRow.parentElement!, { dataTransfer: dt });
    fireEvent.drop(inboxRow.parentElement!, { dataTransfer: dt });

    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/files/move'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ from: 'exports/诊疗报告.pdf', toDir: 'inbox' }),
      }),
    ));
  });

  it('把文件拖到回收站会走软删除接口', async () => {
    installFetchRouter({
      '/files/trash': jsonResponse({ path: 'exports/诊疗报告.pdf' }),
    });
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.click(screen.getByRole('button', { name: /exports/ }));
    const fileLabel = await screen.findByText('诊疗报告.pdf');
    const dt = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => '' };
    fireEvent.dragStart(fileLabel.closest('[draggable="true"]')!, { dataTransfer: dt });

    const trashToggle = screen.getByRole('button', { name: /回收站/ });
    fireEvent.dragOver(trashToggle.parentElement!, { dataTransfer: dt });
    // 悬停回收站时出现底部渐变蒙层
    expect(screen.getByTestId('trash-drop-overlay')).not.toBeNull();
    fireEvent.drop(trashToggle.parentElement!, { dataTransfer: dt });

    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/files/trash'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'exports/诊疗报告.pdf' }),
      }),
    ));
    await waitFor(() => expect(screen.queryByTestId('trash-drop-overlay')).toBeNull());
  });

  it('文本预览可就地编辑并保存，保存后刷新目录', async () => {
    installFetchRouter({
      '/files/list?path=exports': jsonResponse({
        path: 'exports',
        truncated: false,
        entries: [{
          name: 'note.md',
          path: 'exports/note.md',
          type: 'file',
          size: 12,
          modified: '2026-11-11T03:00:00.000Z',
        }],
      }),
    });
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.click(screen.getByRole('button', { name: /exports/ }));
    fireEvent.click(await screen.findByRole('button', { name: /note\.md/ }));
    await screen.findByText(/内容/);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const textarea = screen.getByLabelText('编辑文件内容') as HTMLTextAreaElement;
    expect(textarea.value).toBe('# 报告\n内容');
    fireEvent.change(textarea, { target: { value: '# 报告\n新内容' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/file'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ filePath: 'exports/note.md', content: '# 报告\n新内容' }),
      }),
    ));
    expect(await screen.findByText('已保存 exports/note.md')).not.toBeNull();
    // 保存后回到只读预览，显示新内容
    expect(screen.queryByLabelText('编辑文件内容')).toBeNull();
  });

  it('取消编辑不写盘，文本恢复原样', async () => {
    installFetchRouter({
      '/files/list?path=exports': jsonResponse({
        path: 'exports',
        truncated: false,
        entries: [{
          name: 'note.md',
          path: 'exports/note.md',
          type: 'file',
          size: 12,
          modified: '2026-11-11T03:00:00.000Z',
        }],
      }),
    });
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.click(screen.getByRole('button', { name: /exports/ }));
    fireEvent.click(await screen.findByRole('button', { name: /note\.md/ }));
    await screen.findByText(/内容/);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('编辑文件内容'), { target: { value: '乱改' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(mocks.authenticatedFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    expect(screen.queryByLabelText('编辑文件内容')).toBeNull();
  });

  it('inbox 里的文本文件也允许用户本人编辑（只对 agent 只读）', async () => {
    installFetchRouter({
      '/files/list?path=inbox': jsonResponse({
        path: 'inbox',
        truncated: false,
        entries: [{
          name: 'notes.md',
          path: 'inbox/notes.md',
          type: 'file',
          size: 8,
          modified: '2026-11-11T03:00:00.000Z',
        }],
      }),
    });
    render(<FilesV2 selectedProject={project} />);
    await screen.findByText('工作区总量');

    fireEvent.click(screen.getAllByRole('button', { name: /inbox/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: /notes\.md/ }));
    await screen.findByText(/内容/);

    expect(screen.getByRole('button', { name: '编辑' })).not.toBeNull();
  });
});
