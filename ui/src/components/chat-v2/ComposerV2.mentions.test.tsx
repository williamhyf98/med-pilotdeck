// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import ComposerV2, { type ComposerV2Props } from './ComposerV2';
import { getThinkingModeAvailability } from '../chat/constants/thinkingModeAvailability';
import { WORKSPACE_FILE_MENTION_DRAG_MIME } from '../../utils/workspaceFileMention';

afterEach(cleanup);

const folderFile = new File(['report'], 'report.txt', { type: 'text/plain' });
const ordinaryFile = new File(['extra'], 'extra.txt', { type: 'text/plain' });
const fileTree: ComposerV2Props['filteredFileTree'] = [{
  name: 'inbox',
  path: 'inbox',
  kind: 'directory',
  children: [{
    name: 'case-001',
    path: 'inbox/case-001',
    kind: 'directory',
    children: [{ name: 'report.txt', path: 'inbox/case-001/report.txt', kind: 'file' }],
  }],
}, {
  name: 'exports',
  path: 'exports',
  kind: 'directory',
  children: [{ name: 'brief.pdf', path: 'exports/brief.pdf', kind: 'file' }],
}];

function composerProps(overrides: Partial<ComposerV2Props> = {}): ComposerV2Props {
  return {
    input: '@',
    placeholder: 'Message',
    textareaRef: { current: null } as RefObject<HTMLTextAreaElement>,
    onInputChange: vi.fn(),
    onTextareaClick: vi.fn(),
    onTextareaKeyDown: vi.fn(),
    onTextareaPaste: vi.fn(),
    onTextareaInput: vi.fn(),
    onSubmit: vi.fn((event) => event.preventDefault()),
    onAbortSession: vi.fn(),
    openImagePicker: vi.fn(),
    attachedImages: [],
    onRemoveImage: vi.fn(),
    documentReferences: [],
    onRemoveDocumentReference: vi.fn(),
    mentionedFiles: [],
    onRemoveMentionedFile: vi.fn(),
    uploadingImages: new Map(),
    imageErrors: new Map(),
    showFileDropdown: true,
    filteredFiles: [fileTree[1].children![0]],
    filteredFileTree: fileTree,
    selectedFileIndex: -1,
    mentionProjectName: 'project-a',
    expandedMentionDirectories: new Set(['inbox', 'exports']),
    onToggleMentionDirectory: vi.fn(),
    onSelectFile: vi.fn(),
    filteredCommands: [],
    selectedCommandIndex: -1,
    onCommandSelect: vi.fn(),
    onCloseCommandMenu: vi.fn(),
    isCommandMenuOpen: false,
    frequentCommands: [],
    onToggleCommandMenu: vi.fn(),
    onInsertMention: vi.fn(),
    onInsertSlash: vi.fn(),
    getRootProps: () => ({}),
    getInputProps: () => ({ type: 'file' }),
    isDragActive: false,
    isLoading: false,
    canAbortSession: false,
    thinkingMode: 'default',
    thinkingModeAvailability: getThinkingModeAvailability(),
    onThinkingModeChange: vi.fn(),
    pendingPermissionRequests: [],
    handlePermissionDecision: vi.fn(),
    handleGrantToolPermission: vi.fn(() => ({ success: true })),
    permissionMode: 'default',
    runMode: 'agent',
    onRunModeChange: vi.fn(),
    ...overrides,
  };
}

describe('ComposerV2 file mentions', () => {
  it('shows two expanded roots, keeps child folders folded, and separates expand from mention', () => {
    const onSelectFile = vi.fn();
    const onToggleMentionDirectory = vi.fn();
    const props = composerProps({ onSelectFile, onToggleMentionDirectory });
    const { rerender } = render(<ComposerV2 {...props} />);

    expect(screen.getByRole('treeitem', { name: 'inbox' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'exports' }).getAttribute('aria-expanded')).toBe('true');
    const childFolder = screen.getByRole('treeitem', { name: /case-001/ });
    expect(childFolder.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: 'report.txt' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mention directory inbox' })).toBeNull();

    fireEvent.click(childFolder);
    expect(onToggleMentionDirectory).toHaveBeenCalledWith('inbox/case-001');
    expect(onSelectFile).not.toHaveBeenCalled();
    fireEvent.click(within(childFolder).getByRole('button', { name: 'Mention directory inbox/case-001' }));
    expect(onSelectFile).toHaveBeenCalledWith(fileTree[0].children![0]);

    rerender(<ComposerV2 {...props} expandedMentionDirectories={new Set(['inbox', 'exports', 'inbox/case-001'])} />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'report.txt' }));
    expect(onSelectFile).toHaveBeenCalledWith(fileTree[0].children![0].children![0]);
  });

  it('renders a folder as one expandable card and leaves ordinary attachments separate', () => {
    const onRemoveMedicalFolder = vi.fn();
    render(<ComposerV2 {...composerProps({
      attachedImages: [folderFile, ordinaryFile],
      attachedMedicalFolders: [{
        id: 'folder-a',
        rootName: 'case-001',
        entries: [{ file: folderFile, relativePath: 'case-001/report.txt' }],
      }],
      onRemoveMedicalFolder,
    })} />);

    expect(screen.getByText('extra.txt')).not.toBeNull();
    expect(screen.queryByText('report.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /case-001.*1 files/ }));
    expect(screen.getByText('case-001/report.txt')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder' }));
    expect(onRemoveMedicalFolder).toHaveBeenCalledWith('folder-a');
  });

  it('accepts a workspace mention drop without treating it as an uploaded file', () => {
    const onDropWorkspaceMention = vi.fn(() => true);
    const { container } = render(<ComposerV2 {...composerProps({ onDropWorkspaceMention })} />);
    const dataTransfer = {
      types: [WORKSPACE_FILE_MENTION_DRAG_MIME],
      dropEffect: 'none',
      getData: (type: string) => type === WORKSPACE_FILE_MENTION_DRAG_MIME
        ? JSON.stringify({ projectName: 'project-a', relativePath: 'inbox/case-001', kind: 'directory' })
        : '',
    } as unknown as DataTransfer;
    const form = container.querySelector('form')!;
    fireEvent.dragOver(form, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('copy');
    fireEvent.drop(form, { dataTransfer });
    expect(onDropWorkspaceMention).toHaveBeenCalledWith(dataTransfer);
  });

  it('cancels an @ tree drag when dropped back anywhere inside the popup', () => {
    const onSelectFile = vi.fn();
    const onDropWorkspaceMention = vi.fn();
    render(<ComposerV2 {...composerProps({ onSelectFile, onDropWorkspaceMention })} />);
    const folder = screen.getByRole('treeitem', { name: /case-001/ });
    const popup = screen.getByRole('tree').parentElement!;
    const dataTransfer = {
      types: [WORKSPACE_FILE_MENTION_DRAG_MIME],
      setData: vi.fn(),
      dropEffect: 'none',
    } as unknown as DataTransfer;

    fireEvent.dragStart(folder, { dataTransfer });
    fireEvent.dragOver(popup, { dataTransfer });
    fireEvent.drop(popup, { dataTransfer });
    fireEvent.dragEnd(folder, { dataTransfer });

    expect(onSelectFile).not.toHaveBeenCalled();
    expect(onDropWorkspaceMention).not.toHaveBeenCalled();
  });

  it('adds an @ tree file only when dropped outside the popup, without double handling', () => {
    const onSelectFile = vi.fn();
    const onDropWorkspaceMention = vi.fn();
    render(<ComposerV2 {...composerProps({ onSelectFile, onDropWorkspaceMention })} />);
    const file = screen.getByRole('treeitem', { name: 'brief.pdf' });
    const dataTransfer = {
      types: [WORKSPACE_FILE_MENTION_DRAG_MIME],
      setData: vi.fn(),
      dropEffect: 'none',
    } as unknown as DataTransfer;

    fireEvent.dragStart(file, { dataTransfer });
    fireEvent.dragOver(screen.getByPlaceholderText('Message'), { dataTransfer });
    fireEvent.drop(screen.getByPlaceholderText('Message'), { dataTransfer });
    fireEvent.dragEnd(file, { dataTransfer });

    expect(onSelectFile).toHaveBeenCalledExactlyOnceWith(fileTree[1].children![0]);
    expect(onDropWorkspaceMention).not.toHaveBeenCalled();
  });

  it('does not add a reference when the @ tree drag ends without a drop', () => {
    const onSelectFile = vi.fn();
    render(<ComposerV2 {...composerProps({ onSelectFile })} />);
    const file = screen.getByRole('treeitem', { name: 'brief.pdf' });
    const dataTransfer = { setData: vi.fn(), dropEffect: 'none' } as unknown as DataTransfer;

    fireEvent.dragStart(file, { dataTransfer });
    fireEvent.dragEnd(file, { dataTransfer });

    expect(onSelectFile).not.toHaveBeenCalled();
  });
});
