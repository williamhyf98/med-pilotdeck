// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StorageV2 from './StorageV2';

const authenticatedFetch = vi.hoisted(() => vi.fn());

vi.mock('../../utils/api', () => ({ authenticatedFetch }));

const snapshot = {
  totals: { totalBytes: 3072, workspaceBytes: 2048, archiveBytes: 1024 },
  workspaces: [{
    id: 'general_med-one',
    projectId: 'general_med-one',
    displayName: '病例讨论',
    projectType: 'general_medicine',
    typeKey: 'general_med',
    sizeBytes: 2048,
    files: [{
      path: 'exports/report.md',
      name: 'report.md',
      sizeBytes: 2048,
      previewKind: 'text',
    }],
  }],
  archives: [{
    id: 'trauma_med-old-20260831T010203Z',
    projectId: 'trauma_med-old',
    archivedAt: '20260831T010203Z',
    sizeBytes: 1024,
    files: [{
      path: 'inbox/image.png',
      name: 'image.png',
      sizeBytes: 1024,
      previewKind: 'image',
    }],
  }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    headers: new Headers(),
  } as unknown as Response;
}

describe('StorageV2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticatedFetch.mockResolvedValue(jsonResponse(snapshot));
  });

  afterEach(() => {
    cleanup();
  });

  it('shows storage totals and switches between live and archive groups', async () => {
    render(<StorageV2 />);

    await screen.findByText('病例讨论');
    expect(screen.getByText('3.0 KB')).toBeTruthy();
    expect(screen.getByText('report.md')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /归档/ }));
    expect(await screen.findByText('trauma_med-old-20260831T010203Z')).toBeTruthy();
  });

  it('deletes a selected file only after confirmation', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse({
        deleted: [{}],
        failed: [],
        snapshot: {
          ...snapshot,
          totals: { totalBytes: 1024, workspaceBytes: 0, archiveBytes: 1024 },
          workspaces: [{ ...snapshot.workspaces[0], sizeBytes: 0, files: [] }],
        },
      }));
    render(<StorageV2 />);

    await screen.findByText('report.md');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 report.md' }));
    fireEvent.click(screen.getByRole('button', { name: /删除选中/ }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    await waitFor(() => {
      expect(authenticatedFetch).toHaveBeenCalledWith('/api/storage/delete', expect.objectContaining({
        method: 'POST',
      }));
    });
    const request = authenticatedFetch.mock.calls[1][1];
    expect(JSON.parse(request.body)).toEqual({
      targets: [{
        kind: 'file',
        scope: 'workspace',
        groupId: 'general_med-one',
        typeKey: 'general_med',
        path: 'exports/report.md',
      }],
    });
  });

  it('allows an empty archive folder to be selected and deleted as a whole', async () => {
    const emptySnapshot = {
      totals: { totalBytes: 0, workspaceBytes: 0, archiveBytes: 0 },
      workspaces: [{
        ...snapshot.workspaces[0],
        sizeBytes: 0,
        files: [],
      }],
      archives: [{
        ...snapshot.archives[0],
        sizeBytes: 0,
        files: [],
      }],
    };
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(emptySnapshot))
      .mockResolvedValueOnce(jsonResponse({
        deleted: [{}],
        failed: [],
        snapshot: { ...emptySnapshot, archives: [] },
      }));
    render(<StorageV2 />);

    await screen.findByText('病例讨论');
    const liveCheckbox = screen.getByRole('checkbox', { name: '选择 病例讨论 的全部文件' }) as HTMLInputElement;
    const liveDelete = screen.getByRole('button', { name: '清空 病例讨论 工作区' }) as HTMLButtonElement;
    expect(liveCheckbox.disabled).toBe(true);
    expect(liveDelete.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /归档/ }));
    const archiveName = 'trauma_med-old-20260831T010203Z';
    const archiveCheckbox = await screen.findByRole('checkbox', {
      name: `选择归档 ${archiveName} 整包`,
    }) as HTMLInputElement;
    const archiveDelete = screen.getByRole('button', {
      name: `删除归档 ${archiveName}`,
    }) as HTMLButtonElement;
    expect(archiveCheckbox.disabled).toBe(false);
    expect(archiveDelete.disabled).toBe(false);

    fireEvent.click(archiveCheckbox);
    fireEvent.click(screen.getByRole('button', { name: /删除选中/ }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));

    await waitFor(() => {
      expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    });
    const request = authenticatedFetch.mock.calls[1][1];
    expect(JSON.parse(request.body)).toEqual({
      targets: [{
        kind: 'archive',
        scope: 'archive',
        groupId: archiveName,
      }],
    });
  });
});
