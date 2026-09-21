// @vitest-environment jsdom
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import MainAreaV2 from './MainAreaV2';

vi.mock('../main-content/view/MainContent', async () => {
  const React = await import('react');
  const { useRegisterChatHistorySearchControls } = await import(
    '../chat-v2/ChatHistorySearchController'
  );

  function RegisteredSearchMock({ activeTab }: { activeTab: AppTab }) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [activeMatchIndex, setActiveMatchIndex] = React.useState(0);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const openSearch = React.useCallback(() => setIsOpen(true), []);
    const closeSearch = React.useCallback(() => {
      setIsOpen(false);
      setQuery('');
    }, []);
    const matches = query ? [{}, {}] : [];
    useRegisterChatHistorySearchControls({
      isOpen,
      openSearch,
      closeSearch,
      query,
      setQuery,
      matches,
      activeMatchIndex,
      goToPrevious: () => setActiveMatchIndex((index) => Math.max(0, index - 1)),
      goToNext: () => setActiveMatchIndex((index) => Math.min(matches.length - 1, index + 1)),
      inputRef,
    });

    return (
      <div
        data-testid="main-content"
        data-active-tab={activeTab}
        data-search-open={isOpen ? 'true' : 'false'}
        data-search-query={query}
        data-search-index={activeMatchIndex}
      >
        <button type="button" onClick={openSearch}>Open registered chat search</button>
      </div>
    );
  }

  return {
    default: ({
      activeTab,
      selectedSession,
    }: {
      activeTab: AppTab;
      selectedSession: ProjectSession | null;
    }) => selectedSession
      ? <RegisteredSearchMock activeTab={activeTab} />
      : <div data-testid="main-content" data-active-tab={activeTab} />,
  };
});

vi.mock('../../utils/api', () => ({
  api: {
    alwaysOnDashboardEvents: vi.fn(async () => new Response(JSON.stringify({ events: [] }))),
  },
}));

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
};

function Harness({
  initialTab = 'chat',
  withSession = false,
}: {
  initialTab?: AppTab;
  withSession?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<AppTab>(initialTab);
  const props = {
    projects: [project],
    selectedProject: project,
    selectedSession: withSession ? { id: 'session-1', title: 'Searchable chat' } : null,
    activeTab,
    setActiveTab,
  } as unknown as ComponentProps<typeof MainAreaV2>;

  return <MainAreaV2 {...props} />;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('MainAreaV2 dashboard switcher', () => {
  it('renames the selected session inline after double-clicking the header title', () => {
    render(<Harness withSession />);

    fireEvent.doubleClick(screen.getByTitle('Searchable chat'));
    const input = screen.getByRole('textbox', { name: 'Rename Session' });
    expect((input as HTMLInputElement).value).toBe('Searchable chat');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'Renamed conversation' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTitle('Renamed conversation').textContent).toBe('Renamed conversation');
    expect(JSON.parse(localStorage.getItem('pilotdeck:customSessionTitles') || '{}')).toEqual({
      'session-1': 'Renamed conversation',
    });
  });

  it('cancels an inline session rename when Escape is pressed', () => {
    render(<Harness withSession />);

    fireEvent.doubleClick(screen.getByTitle('Searchable chat'));
    const input = screen.getByRole('textbox', { name: 'Rename Session' });
    fireEvent.change(input, { target: { value: 'Discarded title' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.getByTitle('Searchable chat').textContent).toBe('Searchable chat');
    expect(localStorage.getItem('pilotdeck:customSessionTitles')).toBeNull();
  });

  it('keeps the header search state in sync and returns from Files to chat', async () => {
    render(<Harness initialTab="files" withSession />);

    const tools = screen.getByLabelText('Tools');
    const searchButton = within(tools).getByRole('button', { name: 'Search current conversation' });
    const toolButtons = within(tools).getAllByRole('button');

    expect(toolButtons[0]).toBe(searchButton);
    expect(toolButtons).toHaveLength(1);
    expect(searchButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(searchButton);
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('chat');
    expect(screen.getByTestId('main-content').getAttribute('data-search-open')).toBe('true');
    expect(searchButton.getAttribute('aria-pressed')).toBe('true');
    expect(searchButton.className).toContain('bg-blue-100');
    expect(searchButton.className).toContain('text-blue-700');
    expect(searchButton.className).not.toContain('shadow');

    const headerSearch = within(screen.getByRole('banner')).getByRole('search');
    expect(headerSearch.className).not.toContain('absolute');
    expect(headerSearch.className).not.toContain('shadow');
    expect(within(headerSearch).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByTitle('Searchable chat').textContent).toBe('Searchable chat');
    fireEvent.click(searchButton);
    await waitFor(() => expect(searchButton.getAttribute('aria-pressed')).toBe('false'));

  });

  it('disables chat search while no conversation is mounted', () => {
    render(<Harness />);

    expect(
      (screen.getByRole('button', { name: 'Search current conversation' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('does not leave Files when an embedded chat search opens', () => {
    render(<Harness initialTab="files" withSession />);

    fireEvent.click(screen.getByRole('button', { name: 'Open registered chat search' }));

    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');
    expect(screen.getByTestId('main-content').getAttribute('data-search-open')).toBe('true');
  });

  it('preserves Chinese IME composition through the header search controller', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    render(<Harness withSession />);

    fireEvent.click(screen.getByRole('button', { name: 'Search current conversation' }));
    const input = screen.getByRole('searchbox') as HTMLInputElement;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'wos' } });
    expect(input.value).toBe('wos');
    expect(screen.getByTestId('main-content').getAttribute('data-search-query')).toBe('');

    fireEvent.change(input, { target: { value: '我是' } });
    fireEvent.compositionEnd(input);

    await waitFor(() => {
      expect(input.value).toBe('我是');
      expect(screen.getByTestId('main-content').getAttribute('data-search-query')).toBe('我是');
    });

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, which: 13 });
    expect(screen.getByTestId('main-content').getAttribute('data-search-index')).toBe('0');

    now.mockReturnValue(1_200);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, which: 13 });
    expect(screen.getByTestId('main-content').getAttribute('data-search-index')).toBe('1');
  });

  // File navigation and management dashboard toggles live in SidebarV2.
  // Their interactions are covered in SidebarV2.test.tsx.
});
