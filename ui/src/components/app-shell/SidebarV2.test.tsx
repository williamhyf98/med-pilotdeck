// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
import SidebarV2 from './SidebarV2';

const generalMed: Project = {
  name: 'general_med-clinic',
  displayName: '门诊随访',
  fullPath: '/ws/general_med-clinic',
  projectType: 'general_medicine',
  sessions: [],
};

const traumaMed: Project = {
  name: 'trauma_med-field',
  displayName: '战地救治',
  fullPath: '/ws/trauma_med-field',
  projectType: 'war_trauma',
  sessions: [],
};

function renderSidebar(
  selectedProject: Project | null,
  projects: Project[] = [generalMed, traumaMed],
  extras: Partial<ComponentProps<typeof SidebarV2>> = {},
) {
  const props: ComponentProps<typeof SidebarV2> = {
    projects,
    selectedProject,
    selectedSession: null,
    activeTab: 'chat',
    isLoading: false,
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onCreateProject: vi.fn(),
    onRequestDeleteProject: vi.fn(),
    onRequestDeleteSession: vi.fn(),
    onShowSettings: vi.fn(),
    ...extras,
  };

  return {
    ...render(
      <MemoryRouter>
        <SidebarV2 {...props} />
      </MemoryRouter>,
    ),
    props,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SidebarV2 type tabs (P3)', () => {
  it('always shows General Med and War Trauma tabs', () => {
    renderSidebar(null, [generalMed]);
    expect(screen.getByRole('tab', { name: 'General Med' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'War Trauma' })).toBeTruthy();
  });

  it('lists only projects for the active type tab', () => {
    renderSidebar(generalMed);

    expect(screen.getByText('门诊随访')).toBeTruthy();
    expect(screen.queryByText('战地救治')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'War Trauma' }));
    expect(screen.getByText('战地救治')).toBeTruthy();
    expect(screen.queryByText('门诊随访')).toBeNull();
  });

  it('auto-flips to War Trauma when a trauma project is selected', async () => {
    renderSidebar(traumaMed);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'War Trauma' }).getAttribute('aria-selected')).toBe('true');
    });
    expect(screen.getByText('战地救治')).toBeTruthy();
  });

  it('shows create-project control in the list header', () => {
    const { props } = renderSidebar(generalMed);
    fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
    expect(props.onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('allows creating a project from the War Trauma section', () => {
    const { props } = renderSidebar(generalMed, [generalMed]);
    fireEvent.click(screen.getByRole('tab', { name: 'War Trauma' }));

    expect(screen.getByText('No projects in this type yet. Create one above.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
    expect(props.onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('reports section changes so the workspace background follows the selected type', () => {
    const onSectionChange = vi.fn();
    renderSidebar(null, [generalMed, traumaMed], { onSectionChange });

    fireEvent.click(screen.getByRole('tab', { name: 'War Trauma' }));

    expect(onSectionChange).toHaveBeenCalledWith('war_trauma');
  });

  it('opens project files from the folder action next to new chat', () => {
    const onOpenProjectFiles = vi.fn();
    renderSidebar(generalMed, [generalMed, traumaMed], { onOpenProjectFiles });

    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(onOpenProjectFiles).toHaveBeenCalledWith(generalMed);
  });

  it('shows only Skills, Memory, and Storage above Settings', () => {
    const onSelectTab = vi.fn();
    renderSidebar(generalMed, [generalMed, traumaMed], { onSelectTab });

    expect(screen.getByRole('button', { name: '技能' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '记忆' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '存储' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dashboard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Always On' })).toBeNull();
    expect(screen.getByRole('button', { name: '技能' }).closest('.border-t')).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' }).parentElement?.className)
      .toContain('border-t');

    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    expect(onSelectTab).toHaveBeenCalledWith('memory');
  });

  it('keeps the selected conversation highlighted while Memory is open and returns to chat', () => {
    const onSelectTab = vi.fn();
    const session = { id: 'session-memory', title: '当前问诊' };
    const project = { ...generalMed, sessions: [session] };

    renderSidebar(project, [project], {
      activeTab: 'memory',
      selectedSession: session,
      onSelectTab,
    });

    const sessionButton = screen.getByRole('button', { name: /当前问诊/ });
    expect(sessionButton.getAttribute('aria-current')).toBe('page');
    expect(sessionButton.closest('.pd-session-row')?.className).toContain('pd-session-row-active');

    const memoryButton = screen.getByRole('button', { name: '记忆' });
    expect(memoryButton.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(memoryButton);
    expect(onSelectTab).toHaveBeenCalledWith('chat');
  });
});
