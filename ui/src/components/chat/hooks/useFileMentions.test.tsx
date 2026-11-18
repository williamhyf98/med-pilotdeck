import { act, renderHook, waitFor } from '@testing-library/react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/app';
import {
  ADD_WORKSPACE_FILE_MENTION_EVENT,
  WORKSPACE_FILE_MENTION_DRAG_MIME,
} from '../../../utils/workspaceFileMention';
import { useFileMentions } from './useFileMentions';

const { getFilesMock, listFilesMock } = vi.hoisted(() => ({
  getFilesMock: vi.fn(),
  listFilesMock: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: listFilesMock,
  api: {
    getFiles: getFilesMock,
  },
}));

const project = {
  name: 'project-a',
  displayName: 'Project A',
  fullPath: '/workspace/project-a',
} as Project;

const textareaRef = { current: null } as RefObject<HTMLTextAreaElement>;

describe('useFileMentions chips', () => {
  beforeEach(() => {
    getFilesMock.mockReset();
    listFilesMock.mockReset();
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  it('adds an external mention as a chip without touching the input text', () => {
    const setInput = vi.fn<Dispatch<SetStateAction<string>>>();
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: 'xyz',
      setInput,
      textareaRef,
    }));
    setInput.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
        detail: {
          projectName: project.name,
          relativePath: 'docs/report.docx',
        },
      }));
    });

    expect(setInput).not.toHaveBeenCalled();
    expect(result.current.mentionedFiles).toEqual([
      {
        name: 'report.docx',
        relativePath: 'docs/report.docx',
        kind: 'file',
        absolutePath: '/workspace/project-a/docs/report.docx',
      },
    ]);
  });

  it('dedupes external mentions by relative path', () => {
    const setInput = vi.fn<Dispatch<SetStateAction<string>>>();
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: '',
      setInput,
      textareaRef,
    }));

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
        detail: { projectName: project.name, relativePath: 'docs/report.docx' },
      }));
      window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
        detail: { projectName: project.name, relativePath: 'docs/report.docx' },
      }));
    });

    expect(result.current.mentionedFiles).toHaveLength(1);
  });

  it('clears chips when the conversation scope changes', () => {
    const setInput = vi.fn<Dispatch<SetStateAction<string>>>();
    const { result, rerender } = renderHook(
      (props: { mentionScopeKey: string }) => useFileMentions({
        selectedProject: project,
        mentionScopeKey: props.mentionScopeKey,
        input: '',
        setInput,
        textareaRef,
      }),
      { initialProps: { mentionScopeKey: 'draft_input_project-a:session-a' } },
    );

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
        detail: { projectName: project.name, relativePath: 'docs/report.docx' },
      }));
    });
    expect(result.current.mentionedFiles).toHaveLength(1);

    rerender({ mentionScopeKey: 'draft_input_project-a:session-b' });
    expect(result.current.mentionedFiles).toHaveLength(0);
  });

  it('removes a chip by relative path', () => {
    const setInput = vi.fn<Dispatch<SetStateAction<string>>>();
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: '',
      setInput,
      textareaRef,
    }));

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
        detail: { projectName: project.name, relativePath: 'docs/report.docx' },
      }));
    });
    act(() => {
      result.current.removeMentionedFile('docs/report.docx');
    });

    expect(result.current.mentionedFiles).toHaveLength(0);
  });

  it('selectFile strips the @query from the input and adds a chip', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          name: 'inbox',
          type: 'directory',
          path: '/workspace/project-a/inbox',
          children: [
            {
              name: 'report.docx',
              type: 'file',
              path: '/workspace/project-a/inbox/report.docx',
            },
          ],
        },
      ],
    });

    let inputValue = 'see @rep please';
    const setInput = vi.fn((value: SetStateAction<string>) => {
      inputValue = typeof value === 'function' ? value(inputValue) : value;
    });
    const { result, rerender } = renderHook(
      (props: { input: string }) => useFileMentions({
        selectedProject: project,
        mentionScopeKey: 'draft_input_project-a:session-a',
        input: props.input,
        setInput,
        textareaRef,
      }),
      { initialProps: { input: inputValue } },
    );

    // Cursor right after "@rep" opens the dropdown against the fetched list.
    act(() => result.current.setCursorPosition('see @rep'.length));
    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles).toHaveLength(1);
    });

    act(() => {
      result.current.selectFile(result.current.filteredFiles[0]);
    });

    expect(inputValue).toBe('see please');
    expect(result.current.mentionedFiles).toEqual([
      {
        name: 'report.docx',
        relativePath: 'inbox/report.docx',
        absolutePath: '/workspace/project-a/inbox/report.docx',
      },
    ]);
    rerender({ input: inputValue });
    expect(result.current.showFileDropdown).toBe(false);
  });

  it('filters to inbox and exports and matches nested file paths', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          name: 'inbox',
          type: 'directory',
          path: '/workspace/project-a/inbox',
          children: [
            {
              name: 'case-001',
              type: 'directory',
              children: [
                { name: 'notes.txt', type: 'file', path: '/workspace/project-a/inbox/case-001/notes.txt' },
              ],
            },
          ],
        },
        { name: 'exports', type: 'directory', children: [{ name: 'brief.pdf', type: 'file' }] },
        { name: 'scratch', type: 'directory', children: [{ name: 'scratch.txt', type: 'file' }] },
      ],
    });

    const setInput = vi.fn<Dispatch<SetStateAction<string>>>();
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: '@notes',
      setInput,
      textareaRef,
    }));

    act(() => result.current.setCursorPosition('@notes'.length));
    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles.map((file) => file.path)).toEqual(['inbox/case-001/notes.txt']);
    });

    expect(result.current.filteredFileTree[0]?.children?.[0]?.children?.[0]?.path)
      .toBe('inbox/case-001/notes.txt');
    act(() => result.current.setCursorPosition('@notes'.length));
    expect(result.current.filteredFileTree.some((node) => node.path === 'scratch')).toBe(false);
  });

  it('keeps nested directories collapsed until expanded, and supports folder references', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [{
        name: 'inbox',
        type: 'directory',
        children: [{
          name: 'case-001',
          type: 'directory',
          children: [{ name: 'scan.dcm', type: 'file' }],
        }],
      }],
    });

    let inputValue = '@';
    const setInput = vi.fn((value: SetStateAction<string>) => {
      inputValue = typeof value === 'function' ? value(inputValue) : value;
    });
    const { result, rerender } = renderHook(
      ({ input }) => useFileMentions({
        selectedProject: project,
        mentionScopeKey: 'draft_input_project-a:session-a',
        input,
        setInput,
        textareaRef,
      }),
      { initialProps: { input: inputValue } },
    );
    act(() => result.current.setCursorPosition(1));
    await waitFor(() => expect(result.current.filteredFileTree[0]?.children).toHaveLength(1));
    expect(result.current.filteredFiles).toHaveLength(0);

    act(() => result.current.toggleMentionDirectory('inbox/case-001'));
    expect(result.current.filteredFiles.map((file) => file.path)).toEqual(['inbox/case-001/scan.dcm']);

    act(() => result.current.selectFile(result.current.filteredFileTree[0].children![0]));
    rerender({ input: inputValue });
    expect(result.current.mentionedFiles[0]).toMatchObject({
      relativePath: 'inbox/case-001',
      kind: 'directory',
    });
    expect(inputValue).toBe('');
  });

  it('adds a dragged directory only for the active project', () => {
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: '',
      setInput: vi.fn(),
      textareaRef,
    }));
    const transfer = {
      getData: (type: string) => type === WORKSPACE_FILE_MENTION_DRAG_MIME
        ? JSON.stringify({ projectName: project.name, relativePath: 'exports/results', kind: 'directory' })
        : '',
    } as DataTransfer;
    act(() => expect(result.current.handleWorkspaceFileMentionDrop(transfer)).toBe(true));
    expect(result.current.mentionedFiles[0]).toMatchObject({
      relativePath: 'exports/results',
      kind: 'directory',
    });
    const otherProjectTransfer = {
      getData: () => JSON.stringify({ projectName: 'other', relativePath: 'inbox/report.pdf', kind: 'file' }),
    } as unknown as DataTransfer;
    act(() => expect(result.current.handleWorkspaceFileMentionDrop(otherProjectTransfer)).toBe(false));
    expect(result.current.mentionedFiles).toHaveLength(1);
  });

  it('loads children beyond the initial tree depth when a directory is opened', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [{
        name: 'inbox',
        type: 'directory',
        children: [{ name: 'deep', type: 'directory' }],
      }],
    });
    listFilesMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [{ name: 'scan.dcm', type: 'file', path: 'inbox/deep/scan.dcm' }],
        truncated: false,
      }),
    });
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: '@',
      setInput: vi.fn(),
      textareaRef,
    }));
    act(() => result.current.setCursorPosition(1));
    await waitFor(() => expect(result.current.filteredFileTree[0]?.children).toHaveLength(1));
    act(() => result.current.toggleMentionDirectory('inbox/deep'));
    await waitFor(() => expect(result.current.filteredFiles.map((file) => file.path))
      .toEqual(['inbox/deep/scan.dcm']));
    expect(listFilesMock).toHaveBeenCalledWith(
      '/api/projects/project-a/files/list?path=inbox%2Fdeep',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('removes a pending @query when a file is dragged into the composer', () => {
    let inputValue = 'Review @scan';
    const setInput = vi.fn((value: SetStateAction<string>) => {
      inputValue = typeof value === 'function' ? value(inputValue) : value;
    });
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: inputValue,
      setInput,
      textareaRef,
    }));
    act(() => result.current.setCursorPosition(inputValue.length));
    expect(result.current.showFileDropdown).toBe(true);
    const transfer = {
      getData: (type: string) => type === WORKSPACE_FILE_MENTION_DRAG_MIME
        ? JSON.stringify({ projectName: project.name, relativePath: 'inbox/scan.dcm', kind: 'file' })
        : '',
    } as DataTransfer;
    act(() => expect(result.current.handleWorkspaceFileMentionDrop(transfer)).toBe(true));
    expect(inputValue).toBe('Review ');
    expect(result.current.mentionedFiles[0]?.relativePath).toBe('inbox/scan.dcm');
  });
});
