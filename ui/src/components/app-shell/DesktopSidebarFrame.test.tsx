// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DesktopSidebarFrame from './DesktopSidebarFrame';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe('DesktopSidebarFrame', () => {
  it('keeps the sidebar mounted until its exit finishes and animates reopening', () => {
    vi.useFakeTimers();
    const child = <aside data-sidebar-v2-root style={{ width: 310 }}>菜单内容</aside>;
    const view = render(<DesktopSidebarFrame open>{child}</DesktopSidebarFrame>);
    const frame = screen.getByText('菜单内容').parentElement!;
    expect(frame.className).toContain('pd-app-sidebar-enter');
    expect(frame.style.getPropertyValue('--pd-app-sidebar-width')).toBe('310px');

    view.rerender(<DesktopSidebarFrame open={false}>{child}</DesktopSidebarFrame>);
    expect(frame.className).toContain('pd-app-sidebar-exit');
    expect(screen.getByText('菜单内容')).toBeTruthy();
    act(() => vi.advanceTimersByTime(200));
    view.rerender(<DesktopSidebarFrame open>{child}</DesktopSidebarFrame>);
    expect(frame.className).toContain('pd-app-sidebar-enter');
    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByText('菜单内容')).toBeTruthy();

    view.rerender(<DesktopSidebarFrame open={false}>{child}</DesktopSidebarFrame>);
    act(() => vi.advanceTimersByTime(420));
    expect(screen.queryByText('菜单内容')).toBeNull();
  });
});
