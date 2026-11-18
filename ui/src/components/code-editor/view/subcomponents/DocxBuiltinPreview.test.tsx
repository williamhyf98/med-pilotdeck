// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocxBuiltinPreview from './DocxBuiltinPreview';

const renderAsyncMock = vi.hoisted(() => vi.fn(async (
  _blob: Blob,
  bodyContainer: HTMLElement,
) => {
  const wrapper = document.createElement('div');
  wrapper.className = 'pilotdeck-docx-wrapper';
  for (let index = 0; index < 4; index += 1) {
    const section = document.createElement('section');
    section.className = 'pilotdeck-docx';
    section.textContent = `Document section ${index + 1}`;
    if (index === 0) {
      const heading = document.createElement('h1');
      heading.textContent = 'Introduction';
      section.prepend(heading);
    }
    wrapper.append(section);
  }
  bodyContainer.append(wrapper);
}));

vi.mock('docx-preview', () => ({
  renderAsync: renderAsyncMock,
}));

afterEach(() => {
  cleanup();
  renderAsyncMock.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let availableWidth = 520;
let notifyResize: (() => void) | undefined;

beforeEach(() => {
  availableWidth = 520;
  notifyResize = undefined;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => availableWidth);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches('section.pilotdeck-docx') ? 800 : 0;
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      notifyResize = () => callback([], this as unknown as ResizeObserver);
    }
    observe() {}
    disconnect() {}
  });
});

describe('DocxBuiltinPreview', () => {
  it('fits the whole page on open and keeps manual zoom during resizing', async () => {
    render(
      <DocxBuiltinPreview blob={new Blob(['docx-data'])} fileName="report.docx"
        filePath="report.docx" onError={vi.fn()} />,
    );

    expect(await screen.findByText('59%')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'pdfToolbar.fitWidth' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('pdfToolbar.outline')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'pdfToolbar.zoomIn' }));
    expect(screen.getByText('70%')).not.toBeNull();

    availableWidth = 720;
    notifyResize?.();
    expect(screen.getByText('70%')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'pdfToolbar.fitWidth' }));
    expect(await screen.findByText('82%')).not.toBeNull();
  });

  it('recalculates page fit when the outline changes the document width', async () => {
    render(
      <DocxBuiltinPreview blob={new Blob(['docx-data'])} fileName="report.docx"
        filePath="report.docx" onError={vi.fn()} />,
    );

    expect(await screen.findByText('59%')).not.toBeNull();
    availableWidth = 320;
    fireEvent.click(screen.getByRole('button', { name: 'pdfToolbar.showNavigation' }));
    expect(await screen.findByText('36%')).not.toBeNull();
  });

  it('opens file search as a floating overlay inside the preview surface', async () => {
    render(
      <DocxBuiltinPreview
        blob={new Blob(['docx-data'])}
        fileName="report.docx"
        filePath="report.docx"
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('docx-builtin-preview').textContent).toContain('Document section 4');
    });

    fireEvent.click(screen.getByRole('button', { name: 'builtinOfficePreview.search' }));

    const search = screen.getByRole('search', { name: 'builtinOfficePreview.search' });
    const overlay = search.closest('[data-file-search-overlay]');
    expect(overlay).not.toBeNull();
    expect(overlay?.classList.contains('absolute')).toBe(true);
    expect(screen.getByTestId('docx-builtin-preview')
      .closest('[data-file-search-surface]')
      ?.contains(overlay)).toBe(true);
  });

  it('does not expose rendered sections as Word page controls', async () => {
    render(
      <DocxBuiltinPreview
        blob={new Blob(['docx-data'])}
        fileName="report.docx"
        filePath="report.docx"
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('docx-builtin-preview').textContent).toContain('Document section 4');
    });

    expect(screen.queryByLabelText('builtinOfficePreview.previousItem')).toBeNull();
    expect(screen.queryByLabelText('builtinOfficePreview.nextItem')).toBeNull();
    expect(screen.queryByText('1 / 4')).toBeNull();
  });

  it('does not rebuild the document when callback props change', async () => {
    const blob = new Blob(['docx-data']);
    const props = {
      blob,
      fileName: 'report.docx',
      filePath: 'report.docx',
      onError: vi.fn(),
    };
    const { rerender } = render(<DocxBuiltinPreview {...props} />);

    await waitFor(() => {
      expect(renderAsyncMock).toHaveBeenCalledTimes(1);
    });

    rerender(<DocxBuiltinPreview {...props} onError={vi.fn()} />);

    await Promise.resolve();
    expect(renderAsyncMock).toHaveBeenCalledTimes(1);
  });
});
