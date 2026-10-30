// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
import FilesV2 from './FilesV2';

const mocks = vi.hoisted(() => ({
  refreshFiles: vi.fn(),
  uploadFiles: vi.fn(),
}));

vi.mock('../file-tree/hooks/useFileTreeData', () => ({
  useFileTreeData: () => ({
    loading: false,
    refreshFiles: mocks.refreshFiles,
    files: [
      {
        name: 'inbox',
        type: 'directory',
        path: '/workspace/inbox',
        children: [{
          name: 'batch-1',
          type: 'directory',
          path: '/workspace/inbox/batch-1',
          children: [{
            name: '胸片.png',
            type: 'file',
            path: '/workspace/inbox/batch-1/胸片.png',
            size: 2048,
          }],
        }],
      },
      {
        name: 'exports',
        type: 'directory',
        path: '/workspace/exports',
        children: [{
          name: '诊疗报告.pdf',
          type: 'file',
          path: '/workspace/exports/诊疗报告.pdf',
          size: 4096,
        }],
      },
      {
        name: '.memory',
        type: 'directory',
        path: '/workspace/.memory',
        children: [{
          name: 'profile.json',
          type: 'file',
          path: '/workspace/.memory/profile.json',
        }],
      },
    ],
  }),
}));

vi.mock('../../utils/api', () => ({
  api: {
    uploadFiles: mocks.uploadFiles,
  },
}));

const project: Project = {
  name: 'general_med-test',
  displayName: '测试项目',
  fullPath: '/workspace',
};

describe('FilesV2', () => {
  beforeEach(() => {
    mocks.refreshFiles.mockReset();
    mocks.uploadFiles.mockReset();
    mocks.uploadFiles.mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  afterEach(() => cleanup());

  it('separates uploaded and generated files without exposing internal project files', () => {
    const onFileOpen = vi.fn();
    render(<FilesV2 selectedProject={project} onFileOpen={onFileOpen} />);

    expect(screen.getByText('上传文件')).not.toBeNull();
    expect(screen.getByText('生成文件')).not.toBeNull();
    expect(screen.getByRole('button', { name: /胸片\.png/ })).not.toBeNull();
    expect(screen.getByRole('button', { name: /诊疗报告\.pdf/ })).not.toBeNull();
    expect(screen.queryByText('profile.json')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /诊疗报告\.pdf/ }));
    expect(onFileOpen).toHaveBeenCalledWith('/workspace/exports/诊疗报告.pdf');
  });

  it('uploads selected files into a timestamped inbox batch and refreshes the list', async () => {
    const { container } = render(<FilesV2 selectedProject={project} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new globalThis.File(['report'], '检查结果.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(mocks.uploadFiles).toHaveBeenCalledOnce());
    const [projectName, formData] = mocks.uploadFiles.mock.calls[0] as [string, FormData];
    expect(projectName).toBe(project.name);
    expect(formData.get('targetPath')).toMatch(/^inbox\/uploads\/\d{13}$/);
    expect(formData.getAll('files')).toHaveLength(1);
    expect(mocks.refreshFiles).toHaveBeenCalledOnce();
    expect(screen.getByText('已上传 1 个文件')).not.toBeNull();
  });
});
