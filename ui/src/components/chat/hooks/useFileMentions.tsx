import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { api } from '../../../utils/api';
import { isImeEnterEvent } from '../../../utils/ime';
import {
  ADD_WORKSPACE_FILE_MENTION_EVENT,
  isWorkspaceFileMentionRequest,
} from '../../../utils/workspaceFileMention';
import type { Project } from '../../../types/app';

interface ProjectFileNode {
  name: string;
  type: 'file' | 'directory';
  path?: string;
  children?: ProjectFileNode[];
}

export interface MentionableFile {
  name: string;
  /** Project-relative path (built from tree names). Unique key in the dropdown. */
  path: string;
  /** Server-side absolute path from the tree node, when known. */
  absolutePath?: string;
}

/** A file referenced via @ — rendered as an attachment-style chip, not input text. */
export interface MentionedFile {
  name: string;
  /** Project-relative path — identity for dedupe/removal. */
  relativePath: string;
  /** Absolute path on the server when known; preferred in the agent-visible note. */
  absolutePath?: string;
}

interface UseFileMentionsOptions {
  selectedProject: Project | null;
  mentionScopeKey: string | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
}

const flattenFileTree = (files: ProjectFileNode[], basePath = ''): MentionableFile[] => {
  let flattened: MentionableFile[] = [];

  files.forEach((file) => {
    const fullPath = basePath ? `${basePath}/${file.name}` : file.name;
    if (file.type === 'directory' && file.children) {
      flattened = flattened.concat(flattenFileTree(file.children, fullPath));
      return;
    }

    if (file.type === 'file') {
      flattened.push({
        name: file.name,
        path: fullPath,
        absolutePath: file.path,
      });
    }
  });

  return flattened;
};

export function useFileMentions({
  selectedProject,
  mentionScopeKey,
  input,
  setInput,
  textareaRef,
}: UseFileMentionsOptions) {
  const [fileList, setFileList] = useState<MentionableFile[]>([]);
  const [mentionedFiles, setMentionedFiles] = useState<MentionedFile[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPositionState] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  const wasDropdownOpenRef = useRef(false);

  const setCursorPosition = useCallback((position: number) => {
    setCursorPositionState(position);
  }, []);

  // Track the latest in-flight fetch so a refresh triggered by reopening
  // the @ dropdown can supersede the one kicked off on project switch.
  const inFlightFetchRef = useRef<AbortController | null>(null);

  const fetchProjectFiles = useCallback(async () => {
    const projectName = selectedProject?.name;
    if (!projectName) {
      setFileList([]);
      setFilteredFiles([]);
      return;
    }

    inFlightFetchRef.current?.abort();
    const abortController = new AbortController();
    inFlightFetchRef.current = abortController;

    try {
      const response = await api.getFiles(projectName, { signal: abortController.signal });
      if (!response.ok) {
        return;
      }
      const files = (await response.json()) as ProjectFileNode[];
      if (abortController.signal.aborted) {
        return;
      }
      setFileList(flattenFileTree(files));
    } catch (error) {
      // Ignore aborts from rapid project switches / refreshes.
      if ((error as { name?: string })?.name === 'AbortError') {
        return;
      }
      console.error('Error fetching files:', error);
    } finally {
      if (inFlightFetchRef.current === abortController) {
        inFlightFetchRef.current = null;
      }
    }
  }, [selectedProject?.name]);

  // Initial fetch + reset on project change.
  useEffect(() => {
    setFileList([]);
    setMentionedFiles([]);
    setFilteredFiles([]);
    setCursorPositionState(0);
    fetchProjectFiles();
    return () => {
      inFlightFetchRef.current?.abort();
    };
  }, [fetchProjectFiles]);

  // Mention chips and dropdown state belong to a single draft. A conversation
  // switch can keep the same project mounted, so project identity alone is
  // not enough to prevent chips leaking into another conversation's draft.
  useEffect(() => {
    setMentionedFiles([]);
    setFilteredFiles([]);
    setShowFileDropdown(false);
    setSelectedFileIndex(-1);
    setCursorPositionState(0);
    setAtSymbolPosition(-1);
    wasDropdownOpenRef.current = false;
  }, [mentionScopeKey]);

  // Refresh whenever the @ dropdown transitions from closed → open, so
  // files created / renamed / deleted in the Files tab since the last
  // project switch show up immediately. We intentionally do NOT refetch
  // on every keystroke while the dropdown is already open — the snapshot
  // taken on open is good enough for that session of typing.
  useEffect(() => {
    const wasOpen = wasDropdownOpenRef.current;
    wasDropdownOpenRef.current = showFileDropdown;
    if (!wasOpen && showFileDropdown) {
      fetchProjectFiles();
    }
  }, [showFileDropdown, fetchProjectFiles]);

  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
    if (textAfterAt.includes(' ')) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setSelectedFileIndex(-1);

    // Match on the file name only — paths are intentionally not exposed in
    // the dropdown, so they must not influence what appears to match either.
    const matchingFiles = fileList
      .filter((file) => file.name.toLowerCase().includes(textAfterAt.toLowerCase()))
      .slice(0, 10);

    setFilteredFiles(matchingFiles);
  }, [input, cursorPosition, fileList]);

  const focusTextarea = useCallback(
    (position?: number) => {
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        if (!node.matches(':focus')) {
          node.focus();
        }
        if (typeof position === 'number') {
          try {
            node.setSelectionRange(position, position);
          } catch {
            // ignore: textarea may have been unmounted between frames
          }
        }
      });
    },
    [textareaRef],
  );

  const addMentionedFile = useCallback((file: MentionedFile) => {
    setMentionedFiles((previous) =>
      previous.some((mention) => mention.relativePath === file.relativePath)
        ? previous
        : [...previous, file],
    );
  }, []);

  const removeMentionedFile = useCallback((relativePath: string) => {
    setMentionedFiles((previous) =>
      previous.filter((mention) => mention.relativePath !== relativePath),
    );
  }, []);

  const clearMentionedFiles = useCallback(() => {
    setMentionedFiles([]);
  }, []);

  const addExternalFileMention = useCallback(
    (relativePath: string) => {
      const name = relativePath.split('/').pop() || relativePath;
      const projectRoot = selectedProject?.fullPath || selectedProject?.path || '';
      addMentionedFile({
        name,
        relativePath,
        absolutePath: projectRoot
          ? `${projectRoot.replace(/[\\/]+$/, '')}/${relativePath}`
          : undefined,
      });
      focusTextarea();
    },
    [addMentionedFile, focusTextarea, selectedProject?.fullPath, selectedProject?.path],
  );

  useEffect(() => {
    const handleAddWorkspaceFileMention = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!isWorkspaceFileMentionRequest(detail)) return;
      if (detail.projectName !== selectedProject?.name) return;
      addExternalFileMention(detail.relativePath);
    };

    window.addEventListener(ADD_WORKSPACE_FILE_MENTION_EVENT, handleAddWorkspaceFileMention);
    return () => {
      window.removeEventListener(ADD_WORKSPACE_FILE_MENTION_EVENT, handleAddWorkspaceFileMention);
    };
  }, [addExternalFileMention, selectedProject?.name]);

  const selectFile = useCallback(
    (file: MentionableFile) => {
      // The picked file becomes a chip; the `@query` text that summoned the
      // dropdown is removed from the input instead of being replaced by a path.
      if (atSymbolPosition >= 0) {
        const textBeforeAt = input.slice(0, atSymbolPosition);
        const textAfterAtQuery = input.slice(atSymbolPosition);
        const spaceIndex = textAfterAtQuery.indexOf(' ');
        const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex + 1) : '';

        setInput(`${textBeforeAt}${textAfterQuery}`);
        setCursorPosition(textBeforeAt.length);
        focusTextarea(textBeforeAt.length);
      } else {
        focusTextarea();
      }

      addMentionedFile({
        name: file.name,
        relativePath: file.path,
        absolutePath: file.absolutePath,
      });

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
    },
    [addMentionedFile, atSymbolPosition, focusTextarea, input, setCursorPosition, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown || filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        if (isImeEnterEvent(event)) {
          return false;
        }
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setShowFileDropdown(false);
        return true;
      }

      return false;
    },
    [filteredFiles, selectFile, selectedFileIndex, showFileDropdown],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
    mentionedFiles,
    removeMentionedFile,
    clearMentionedFiles,
  };
}
