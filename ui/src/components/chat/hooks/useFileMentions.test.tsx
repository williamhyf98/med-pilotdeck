import { act, renderHook, waitFor } from '@testing-library/react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/app';
import { ADD_WORKSPACE_FILE_MENTION_EVENT } from '../../../utils/workspaceFileMention';
import { useFileMentions } from './useFileMentions';

const { getFilesMock } = vi.hoisted(() => ({
  getFilesMock: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
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
          name: 'docs',
          type: 'directory',
          path: '/workspace/project-a/docs',
          children: [
            {
              name: 'report.docx',
              type: 'file',
              path: '/workspace/project-a/docs/report.docx',
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
        relativePath: 'docs/report.docx',
        absolutePath: '/workspace/project-a/docs/report.docx',
      },
    ]);
    rerender({ input: inputValue });
    expect(result.current.showFileDropdown).toBe(false);
  });

  it('matches dropdown entries on the file name only, never the path', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          name: 'secret-folder',
          type: 'directory',
          path: '/workspace/project-a/secret-folder',
          children: [
            {
              name: 'notes.txt',
              type: 'file',
              path: '/workspace/project-a/secret-folder/notes.txt',
            },
          ],
        },
      ],
    });

    const setInput = vi.fn<Dispatch<SetStateAction<string>>>();
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: '@secret',
      setInput,
      textareaRef,
    }));

    act(() => result.current.setCursorPosition('@secret'.length));
    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
    });

    // "secret" only appears in the directory path, which is hidden from the
    // dropdown — so it must not match anything either.
    expect(result.current.filteredFiles).toHaveLength(0);
  });
});
