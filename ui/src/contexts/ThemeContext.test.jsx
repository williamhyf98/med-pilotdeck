import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';

function ThemeProbe() {
  const { isDarkMode, setThemeMode, themeMode } = useTheme();

  return (
    <div>
      <output data-testid="theme">{themeMode}</output>
      <output data-testid="dark">{String(isDarkMode)}</output>
      <button type="button" onClick={() => setThemeMode('warm')}>warm</button>
      <button type="button" onClick={() => setThemeMode('command')}>command</button>
      <button type="button" onClick={() => setThemeMode('light')}>light</button>
    </div>
  );
}

describe('ThemeProvider product themes', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
  });

  it('restores the warm theme without enabling dark compatibility', () => {
    localStorage.setItem('themeMode', 'warm');

    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    expect(screen.getByTestId('theme').textContent).toBe('warm');
    expect(screen.getByTestId('dark').textContent).toBe('false');
    expect(document.documentElement.getAttribute('data-theme')).toBe('warm');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('maps the command theme to dark compatibility and persists it', () => {
    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    act(() => screen.getByRole('button', { name: 'command' }).click());

    expect(screen.getByTestId('theme').textContent).toBe('command');
    expect(screen.getByTestId('dark').textContent).toBe('true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('command');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('themeMode')).toBe('command');
  });

  it('removes the product theme attribute when returning to a legacy mode', () => {
    localStorage.setItem('themeMode', 'command');
    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    act(() => screen.getByRole('button', { name: 'light' }).click());
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
