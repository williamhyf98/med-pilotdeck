// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const artifact = {
  name: '今日热点-2026-08-0803.docx',
  path: 'reports/今日热点-2026-08-0803.docx',
};

beforeEach(() => {
  mocks.authenticatedFetch.mockReset();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:rag-image'),
    revokeObjectURL: vi.fn(),
  });
});

describe('Markdown artifact file text', () => {
  it('keeps a generated Unicode filename as plain text', () => {
    render(
      <Markdown artifactFiles={[artifact]} onFileOpen={vi.fn()}>
        已完成今日热点总结并生成文件： 今日热点-2026-08-0803.docx
      </Markdown>,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/今日热点-2026-08-0803\.docx/u)).toBeTruthy();
  });

  it('turns a valid Markdown link for the card artifact back into plain text', () => {
    render(
      <Markdown artifactFiles={[artifact]} onFileOpen={vi.fn()}>
        {`[打开 Word 文件：${artifact.name}](${artifact.name})`}
      </Markdown>,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(`打开 Word 文件：${artifact.name}`)).toBeTruthy();
  });

  it('cleans malformed sandbox links with spaces without exposing the target', () => {
    const spacedArtifact = {
      name: '优秀共产党员推荐审批表-补充 DSMDEM.docx',
      path: 'deliverables/优秀共产党员推荐审批表-补充 DSMDEM.docx',
    };
    render(
      <Markdown artifactFiles={[spacedArtifact]} onFileOpen={vi.fn()}>
        {`[下载：${spacedArtifact.name}](sandbox:/mnt/data/${spacedArtifact.name})`}
      </Markdown>,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(`下载：${spacedArtifact.name}`)).toBeTruthy();
    expect(screen.queryByText(/sandbox:\/\/mnt\/data/u)).toBeNull();
  });

  it('keeps external web links clickable', () => {
    render(
      <Markdown artifactFiles={[artifact]} onFileOpen={vi.fn()}>
        {'查看 [官方网站](https://example.com/report)。'}
      </Markdown>,
    );

    const link = screen.getByRole('link', { name: '官方网站' });
    expect(link.getAttribute('href')).toBe('https://example.com/report');
  });

  it('does not rewrite artifact-looking text inside code', () => {
    render(
      <Markdown artifactFiles={[artifact]} onFileOpen={vi.fn()}>
        {`\`[${artifact.name}](${artifact.name})\``}
      </Markdown>,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(`[${artifact.name}](${artifact.name})`)).toBeTruthy();
  });

  it('loads RAG asset images with authenticated fetch', async () => {
    const blob = new Blob(['image-bytes'], { type: 'image/jpeg' });
    mocks.authenticatedFetch.mockResolvedValue({
      ok: true,
      blob: async () => blob,
    });

    render(
      <Markdown>
        {'![粉毒剂相关图示](/api/plugins/med-tools/rag-assets/assets/aa/image.jpg)'}
      </Markdown>,
    );

    expect(screen.getByText('图片加载中：粉毒剂相关图示')).toBeTruthy();

    const image = await screen.findByRole('img', { name: '粉毒剂相关图示' });
    expect(image.getAttribute('src')).toBe('blob:rag-image');
    expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      '/api/plugins/med-tools/rag-assets/assets/aa/image.jpg',
      { suppressServerErrorToast: true },
    );
  });

  it('leaves non-RAG markdown images as direct image tags', async () => {
    render(
      <Markdown>
        {'![普通图片](/icons/example.svg)'}
      </Markdown>,
    );

    const image = screen.getByRole('img', { name: '普通图片' });
    expect(image.getAttribute('src')).toBe('/icons/example.svg');
    await waitFor(() => {
      expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
    });
  });

  it('does not render placeholder-only image references as broken images', async () => {
    render(
      <Markdown>
        {'步骤①\\n\\n![①](①)'}
      </Markdown>,
    );

    expect(screen.queryByRole('img', { name: '①' })).toBeNull();
    expect(screen.getByText('图片未展示：①')).toBeTruthy();
    await waitFor(() => {
      expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
    });
  });

  it('does not fetch malformed RAG asset placeholder URLs', async () => {
    render(
      <Markdown>
        {'步骤①\\n\\n![①](/api/plugins/med-tools/rag-assets/①)'}
      </Markdown>,
    );

    expect(screen.queryByRole('img', { name: '①' })).toBeNull();
    expect(screen.getByText('图片未展示：①')).toBeTruthy();
    await waitFor(() => {
      expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
    });
  });

  it('does not render images with missing URLs as broken images', () => {
    render(
      <Markdown>
        {'![气道开放步骤]()'}
      </Markdown>,
    );

    expect(screen.queryByRole('img', { name: '气道开放步骤' })).toBeNull();
    expect(screen.getByText('图片未展示：气道开放步骤')).toBeTruthy();
  });
});
