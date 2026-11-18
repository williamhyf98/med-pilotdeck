import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { api, authenticatedFetch } from '../../../utils/api';
import { isImeEnterEvent } from '../../../utils/ime';
import {
  ADD_WORKSPACE_FILE_MENTION_EVENT,
  isWorkspaceFileMentionRequest,
  parseWorkspaceFileMentionDrag,
} from '../../../utils/workspaceFileMention';
import type { Project } from '../../../types/app';

interface ProjectFileNode {
  name: string;
  type: 'file' | 'directory';
  path?: string;
  children?: ProjectFileNode[];
  size?: number | null;
  modified?: string | null;
}

export interface MentionableFile {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number | null;
  modified?: string | null;
  children?: MentionableFile[];
  absolutePath?: string;
  truncated?: boolean;
}

export interface MentionedFile {
  name: string;
  relativePath: string;
  kind?: 'file' | 'directory';
  absolutePath?: string;
}

interface UseFileMentionsOptions {
  selectedProject: Project | null;
  mentionScopeKey: string | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
}

const MENTION_ROOTS = new Set(['inbox', 'exports', 'export']);

function buildMentionTree(files: ProjectFileNode[], basePath = ''): MentionableFile[] {
  return files.map((file) => {
    const fullPath = basePath ? `${basePath}/${file.name}` : file.name;
    return {
      name: file.name,
      path: fullPath,
      kind: file.type,
      size: file.size,
      modified: file.modified,
      ...(file.type === 'directory' && Array.isArray(file.children)
        ? { children: buildMentionTree(file.children, fullPath) }
        : {}),
      ...(file.type === 'file' && file.path ? { absolutePath: file.path } : {}),
    };
  });
}

function flattenFileTree(
  files: MentionableFile[],
  expandedPaths?: Set<string>,
  searchOpen = false,
): MentionableFile[] {
  const flattened: MentionableFile[] = [];
  files.forEach((file) => {
    if (file.kind === 'directory') {
      if (!expandedPaths || searchOpen || expandedPaths.has(file.path)) {
        flattened.push(...flattenFileTree(file.children || [], expandedPaths, searchOpen));
      }
    }
    else flattened.push(file);
  });
  return flattened;
}

function filterMentionTree(files: MentionableFile[], query: string): MentionableFile[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return files;

  return files.flatMap((file) => {
    if (file.kind === 'directory') {
      const directoryMatches = file.path.toLowerCase().includes(normalizedQuery);
      const children = filterMentionTree(file.children || [], query);
      if (!directoryMatches && children.length === 0) return [];
      return [{ ...file, children: directoryMatches ? file.children : children }];
    }

    return file.name.toLowerCase().includes(normalizedQuery)
      || file.path.toLowerCase().includes(normalizedQuery)
      ? [file]
      : [];
  });
}

function findMentionNode(files: MentionableFile[], path: string): MentionableFile | undefined {
  for (const file of files) {
    if (file.path === path) return file;
    const child = findMentionNode(file.children || [], path);
    if (child) return child;
  }
  return undefined;
}

function withDirectoryChildren(
  files: MentionableFile[],
  path: string,
  children: MentionableFile[],
  truncated: boolean,
): MentionableFile[] {
  return files.map((file) => file.path === path
    ? { ...file, children, truncated }
    : file.children
      ? { ...file, children: withDirectoryChildren(file.children, path, children, truncated) }
      : file);
}

export function useFileMentions({
  selectedProject,
  mentionScopeKey,
  input,
  setInput,
  textareaRef,
}: UseFileMentionsOptions) {
  const [fileTree, setFileTree] = useState<MentionableFile[]>([]);
  const [mentionedFiles, setMentionedFiles] = useState<MentionedFile[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [filteredFileTree, setFilteredFileTree] = useState<MentionableFile[]>([]);
  const [fileMentionQuery, setFileMentionQuery] = useState('');
  const [expandedMentionDirectories, setExpandedMentionDirectories] = useState<Set<string>>(
    () => new Set(['inbox', 'exports', 'export']),
  );
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPositionState] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  const wasDropdownOpenRef = useRef(false);
  const inFlightFetchRef = useRef<AbortController | null>(null);
  const inFlightDirectoryFetchesRef = useRef(new Map<string, AbortController>());

  const setCursorPosition = useCallback((position: number) => {
    setCursorPositionState(position);
  }, []);

  const fetchProjectFiles = useCallback(async () => {
    const projectName = selectedProject?.name;
    if (!projectName) {
      setFileTree([]);
      setFilteredFiles([]);
      setFilteredFileTree([]);
      setFileMentionQuery('');
      return;
    }

    inFlightFetchRef.current?.abort();
    const abortController = new AbortController();
    inFlightFetchRef.current = abortController;

    try {
      const response = await api.getFiles(projectName, { signal: abortController.signal });
      if (!response.ok) return;
      const files = (await response.json()) as ProjectFileNode[];
      if (abortController.signal.aborted) return;
      const tree = buildMentionTree(
        files.filter((file) => file.type === 'directory' && MENTION_ROOTS.has(file.name)),
      );
      setFileTree(tree);
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      console.error('Error fetching files:', error);
    } finally {
      if (inFlightFetchRef.current === abortController) inFlightFetchRef.current = null;
    }
  }, [selectedProject?.name]);

  useEffect(() => {
    inFlightDirectoryFetchesRef.current.forEach((controller) => controller.abort());
    inFlightDirectoryFetchesRef.current.clear();
    setFileTree([]);
    setMentionedFiles([]);
    setFilteredFiles([]);
    setFilteredFileTree([]);
    setFileMentionQuery('');
    setExpandedMentionDirectories(new Set(['inbox', 'exports', 'export']));
    setCursorPositionState(0);
    void fetchProjectFiles();
    return () => {
      inFlightFetchRef.current?.abort();
      inFlightDirectoryFetchesRef.current.forEach((controller) => controller.abort());
      inFlightDirectoryFetchesRef.current.clear();
    };
  }, [fetchProjectFiles]);

  useEffect(() => {
    setMentionedFiles([]);
    setFilteredFiles([]);
    setFilteredFileTree([]);
    setShowFileDropdown(false);
    setSelectedFileIndex(-1);
    setCursorPositionState(0);
    setAtSymbolPosition(-1);
    wasDropdownOpenRef.current = false;
  }, [mentionScopeKey]);

  useEffect(() => {
    const wasOpen = wasDropdownOpenRef.current;
    wasDropdownOpenRef.current = showFileDropdown;
    if (!wasOpen && showFileDropdown) void fetchProjectFiles();
  }, [showFileDropdown, fetchProjectFiles]);

  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    if (lastAtIndex === -1) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setFileMentionQuery('');
      return;
    }

    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
    if (textAfterAt.includes(' ')) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setFileMentionQuery('');
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setFileMentionQuery(textAfterAt);
    setSelectedFileIndex(-1);
    const nextTree = filterMentionTree(fileTree, textAfterAt);
    setFilteredFileTree(nextTree);
    setFilteredFiles(flattenFileTree(nextTree, expandedMentionDirectories, Boolean(textAfterAt.trim())));
  }, [input, cursorPosition, fileTree, expandedMentionDirectories]);

  const toggleMentionDirectory = useCallback((path: string) => {
    const shouldExpand = !expandedMentionDirectories.has(path);
    setExpandedMentionDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setSelectedFileIndex(-1);
    const node = findMentionNode(fileTree, path);
    const projectName = selectedProject?.name;
    if (!shouldExpand || !projectName || node?.kind !== 'directory' || node.children
      || inFlightDirectoryFetchesRef.current.has(path)) return;
    const controller = new AbortController();
    inFlightDirectoryFetchesRef.current.set(path, controller);
    void (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/projects/${encodeURIComponent(projectName)}/files/list?path=${encodeURIComponent(path)}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const listing = await response.json() as { entries?: ProjectFileNode[]; truncated?: boolean };
        if (controller.signal.aborted) return;
        setFileTree((previous) => withDirectoryChildren(
          previous,
          path,
          buildMentionTree(listing.entries || [], path),
          Boolean(listing.truncated),
        ));
      } catch (error) {
        if ((error as { name?: string })?.name !== 'AbortError') {
          console.error('Error fetching directory:', error);
        }
      } finally {
        if (inFlightDirectoryFetchesRef.current.get(path) === controller) {
          inFlightDirectoryFetchesRef.current.delete(path);
        }
      }
    })();
  }, [expandedMentionDirectories, fileTree, selectedProject?.name]);

  const focusTextarea = useCallback(
    (position?: number) => {
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        if (!node.matches(':focus')) node.focus();
        if (typeof position === 'number') {
          try {
            node.setSelectionRange(position, position);
          } catch {
            // The textarea may have been unmounted between frames.
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

  const clearMentionedFiles = useCallback(() => setMentionedFiles([]), []);

  const addExternalFileMention = useCallback(
    (relativePath: string, kind: 'file' | 'directory' = 'file') => {
      const name = relativePath.split('/').pop() || relativePath;
      const projectRoot = selectedProject?.fullPath || selectedProject?.path || '';
      addMentionedFile({
        name,
        relativePath,
        kind,
        absolutePath: projectRoot
          ? `${projectRoot.replace(/[\\/]+$/, '')}/${relativePath}`
          : undefined,
      });
      focusTextarea();
    },
    [addMentionedFile, focusTextarea, selectedProject?.fullPath, selectedProject?.path],
  );

  const handleWorkspaceFileMentionDrop = useCallback(
    (dataTransfer: DataTransfer | null | undefined) => {
      const payload = parseWorkspaceFileMentionDrag(dataTransfer);
      if (!payload || payload.projectName !== selectedProject?.name) return false;
      if (showFileDropdown && atSymbolPosition >= 0) {
        const before = input.slice(0, atSymbolPosition);
        setInput(`${before}${input.slice(cursorPosition)}`);
        setCursorPosition(atSymbolPosition);
        setShowFileDropdown(false);
        setAtSymbolPosition(-1);
        focusTextarea(atSymbolPosition);
      }
      addExternalFileMention(payload.relativePath, payload.kind);
      return true;
    },
    [
      addExternalFileMention, atSymbolPosition, cursorPosition, focusTextarea, input,
      selectedProject?.name, setInput, showFileDropdown,
    ],
  );

  useEffect(() => {
    const handleAddWorkspaceFileMention = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!isWorkspaceFileMentionRequest(detail)) return;
      if (detail.projectName !== selectedProject?.name) return;
      addExternalFileMention(
        detail.relativePath,
        detail.kind === 'directory' ? 'directory' : 'file',
      );
    };

    window.addEventListener(ADD_WORKSPACE_FILE_MENTION_EVENT, handleAddWorkspaceFileMention);
    return () => {
      window.removeEventListener(ADD_WORKSPACE_FILE_MENTION_EVENT, handleAddWorkspaceFileMention);
    };
  }, [addExternalFileMention, selectedProject?.name]);

  const selectFile = useCallback(
    (file: MentionableFile) => {
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
        ...(file.kind === 'directory' ? { kind: 'directory' as const } : {}),
        absolutePath: file.absolutePath,
      });
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
    },
    [addMentionedFile, atSymbolPosition, focusTextarea, input, setCursorPosition, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown || filteredFiles.length === 0) return false;
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
        if (isImeEnterEvent(event)) return false;
        event.preventDefault();
        selectFile(filteredFiles[selectedFileIndex >= 0 ? selectedFileIndex : 0]);
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
    filteredFileTree,
    fileMentionQuery,
    expandedMentionDirectories,
    toggleMentionDirectory,
    selectedFileIndex,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
    handleWorkspaceFileMentionDrop,
    mentionedFiles,
    removeMentionedFile,
    clearMentionedFiles,
  };
}
