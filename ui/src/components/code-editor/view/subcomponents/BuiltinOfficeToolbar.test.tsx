// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BuiltinOfficeToolbar from './BuiltinOfficeToolbar';

afterEach(cleanup);

describe('BuiltinOfficeToolbar', () => {
  it('keeps the final controls away from the viewport edge', () => {
    render(
      <BuiltinOfficeToolbar
        zoom={1}
        onZoomChange={vi.fn()}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        searchOpen={false}
        onSearchOpenChange={vi.fn()}
        searchMatchIndex={0}
        searchMatchCount={0}
        onPreviousMatch={vi.fn()}
        onNextMatch={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    const refresh = screen.getByRole('button', { name: /refresh/i });
    const toolbar = refresh.parentElement;
    expect(toolbar?.className).toContain('pr-5');
    expect(toolbar?.className).toContain('scroll-pr-5');
    expect(toolbar?.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});
