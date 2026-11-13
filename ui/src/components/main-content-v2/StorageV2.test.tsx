// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StorageV2 from './StorageV2';

const authenticatedFetch = vi.hoisted(() => vi.fn());

vi.mock('../../utils/api', () => ({ authenticatedFetch }));

const snapshot = {
  totals: { totalBytes: 3072, workspaceBytes: 2048, trashBytes: 1024, projectCount: 1 },
  projects: [{
    id: 'general_med-one',
    displayName: '病例讨论',
    projectType: 'general_medicine',
    typeKey: 'general_med',
    sizeBytes: 2048,
    usage: { inboxBytes: 0, exportsBytes: 2048, scratchBytes: 0, totalBytes: 2048 },
    trashBytes: 1024,
    trashCount: 2,
    sessionCount: 3,
    lastActivityAt: '2026-11-01T02:03:00.000Z',
    folders: [
      { name: 'inbox', fileCount: 0, sizeBytes: 0 },
      { name: 'exports', fileCount: 1, sizeBytes: 2048 },
      { name: 'scratch', fileCount: 0, sizeBytes: 0 },
    ],
    files: [{
      path: 'exports/report.md',
      name: 'report.md',
      sizeBytes: 2048,
      previewKind: 'text' as const,
    }],
  }],
};

const emptySnapshot = {
  totals: { totalBytes: 0, workspaceBytes: 0, trashBytes: 0, projectCount: 0 },
  projects: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => ''),
    blob: vi.fn(async () => new Blob()),
    headers: new Headers(),
  } as unknown as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => ({})),
    text: vi.fn(async () => body),
    blob: vi.fn(async () => new Blob()),
    headers: new Headers(),
  } as unknown as Response;
}

describe('StorageV2（项目视角）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticatedFetch.mockResolvedValue(jsonResponse(snapshot));
  });

  afterEach(() => {
    cleanup();
  });

  it('展示总量与项目行，展开后能看到 exports/inbox/scratch 的目录清单', async () => {
    render(<StorageV2 />);

    await screen.findByText('病例讨论');
    expect(screen.getByText('3.0 KB')).toBeTruthy(); // 总占用
    expect(screen.getAllByText('2.0 KB').length).toBeGreaterThan(1); // 当前文件 + 项目占用
    expect(screen.getByText('1 个')).toBeTruthy(); // 在用项目

    fireEvent.click(screen.getByRole('button', { name: /查看/ }));
    // 三个默认目录固定显示（即使为空），和工作区页一致
    expect(await screen.findByText('inbox')).toBeTruthy();
    expect(screen.getByText('exports')).toBeTruthy();
    expect(screen.getByText('scratch')).toBeTruthy();
    expect(screen.getByText(/exports 2\.0 KB/)).toBeTruthy();
    expect(screen.getByText(/回收站 1\.0 KB（2 个文件）/)).toBeTruthy();
    // 目录默认折叠：文件不直接铺开
    expect(screen.queryByText('report.md')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /exports/ }));
    expect(await screen.findByText('report.md')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /inbox/ }));
    expect(await screen.findByText('空目录')).toBeTruthy();
  });

  it('用户自建目录照常列出，文件按目录分组折叠', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({
      ...snapshot,
      projects: [{
        ...snapshot.projects[0],
        folders: [
          { name: 'inbox', fileCount: 0, sizeBytes: 0 },
          { name: 'exports', fileCount: 0, sizeBytes: 0 },
          { name: 'scratch', fileCount: 0, sizeBytes: 0 },
          { name: '我的资料', fileCount: 1, sizeBytes: 12 },
        ],
        files: [{
          path: '我的资料/ct.png',
          name: 'ct.png',
          sizeBytes: 12,
          previewKind: 'image' as const,
        }],
      }],
    }));
    render(<StorageV2 />);

    fireEvent.click(await screen.findByRole('button', { name: /查看/ }));
    expect(await screen.findByText('我的资料')).toBeTruthy();
    expect(screen.getByText('自定义目录')).toBeTruthy();
    expect(screen.queryByText('ct.png')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /我的资料/ }));
    expect(await screen.findByText('ct.png')).toBeTruthy();
  });

  it('后端没给 folders 时按路径兜底，隐藏目录（.pilotdeck）不出现', async () => {
    const legacyProject = { ...snapshot.projects[0] };
    delete (legacyProject as { folders?: unknown }).folders;
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({
      ...snapshot,
      projects: [{
        ...legacyProject,
        files: [
          ...snapshot.projects[0].files,
          {
            path: '.pilotdeck/tool-results/s1/out.txt',
            name: 'out.txt',
            sizeBytes: 99,
            previewKind: 'text' as const,
          },
        ],
      }],
    }));
    render(<StorageV2 />);

    fireEvent.click(await screen.findByRole('button', { name: /查看/ }));
    expect(await screen.findByText('inbox')).toBeTruthy();
    expect(screen.getByText('exports')).toBeTruthy();
    expect(screen.getByText('scratch')).toBeTruthy();
    expect(screen.queryByText('.pilotdeck')).toBeNull();
    expect(screen.queryByText('out.txt')).toBeNull();
  });

  it('已经取消归档入口', async () => {
    render(<StorageV2 />);
    await screen.findByText('病例讨论');
    expect(screen.queryByRole('button', { name: /^归档/ })).toBeNull();
    expect(screen.queryByText(/已归档项目/)).toBeNull();
  });

  it('预览是只读的，参数走 typeKey/groupId/path', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(textResponse('hello world'));
    render(<StorageV2 />);

    fireEvent.click(await screen.findByRole('button', { name: /查看/ }));
    fireEvent.click(await screen.findByRole('button', { name: /exports/ }));
    fireEvent.click(await screen.findByRole('button', { name: /report\.md/ }));

    await waitFor(() => {
      expect(authenticatedFetch).toHaveBeenCalledWith(
        '/api/storage/preview?typeKey=general_med&groupId=general_med-one&path=exports%2Freport.md',
      );
    });
    expect(await screen.findByText('hello world')).toBeTruthy();
    // 预览不该带任何写操作
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });

  it('删除项目必须手打项目名，确认后真删并刷新', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse({ success: true, projectId: 'general_med-one', deleted: {} }))
      .mockResolvedValueOnce(jsonResponse(emptySnapshot));
    render(<StorageV2 />);

    fireEvent.click(await screen.findByRole('button', { name: /删除项目/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/永久删除项目「病例讨论」/)).toBeTruthy();
    // 只保留一句结论，不再罗列要删的清单
    expect(within(dialog).getByText(/直接从磁盘删除/)).toBeTruthy();
    expect(within(dialog).queryByText(/会话：/)).toBeNull();
    expect(within(dialog).queryByText(/工作区文件：/)).toBeNull();

    const confirmButton = within(dialog).getByRole('button', { name: /永久删除/ });
    expect(confirmButton.hasAttribute('disabled')).toBe(true);

    const input = within(dialog).getByLabelText(/输入项目名/);
    fireEvent.change(input, { target: { value: '病例' } });
    expect(confirmButton.hasAttribute('disabled')).toBe(true);

    fireEvent.change(input, { target: { value: '病例讨论' } });
    expect(confirmButton.hasAttribute('disabled')).toBe(false);

    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(authenticatedFetch).toHaveBeenCalledWith(
        '/api/projects/general_med-one?force=true&confirmName=%E7%97%85%E4%BE%8B%E8%AE%A8%E8%AE%BA',
        { method: 'DELETE' },
      );
    });
    expect(await screen.findByText(/已永久删除「病例讨论」/)).toBeTruthy();
    expect(await screen.findByText('还没有项目')).toBeTruthy();
  });

  it('服务端拒绝时把错误留在弹窗里，不刷新列表', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse({ error: 'Confirmation name does not match the project' }, 400));
    render(<StorageV2 />);

    fireEvent.click(await screen.findByRole('button', { name: /删除项目/ }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(/输入项目名/), { target: { value: '病例讨论' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /永久删除/ }));

    expect(await within(dialog).findByText(/Confirmation name does not match/)).toBeTruthy();
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });
});
