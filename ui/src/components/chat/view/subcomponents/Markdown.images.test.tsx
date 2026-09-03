// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

afterEach(cleanup);

const imageMarkdown = [
  '检索到的图示：',
  '',
  '![图3-1 止血带位置](https://rag.example/figures/a.png)',
  '',
  '![图3-2 加压包扎](https://rag.example/figures/b.png)',
  '',
  '结论见上。',
].join('\n');

describe('Markdown images', () => {
  it('scales images down instead of rendering them at full column width', () => {
    render(<Markdown>{imageMarkdown}</Markdown>);

    const first = screen.getByAltText('图3-1 止血带位置');
    expect(first.className).toContain('max-h-[180px]');
    expect(first.className).toContain('object-contain');
    expect(first.getAttribute('loading')).toBe('lazy');
  });

  it('puts adjacent images in one row', () => {
    const { container } = render(<Markdown>{imageMarkdown}</Markdown>);

    const rows = container.querySelectorAll('div.flex.flex-wrap');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('img')).toHaveLength(2);
  });

  it('keeps an image that sits inside a text paragraph in that paragraph', () => {
    const { container } = render(
      <Markdown>{'如 ![示意图](https://rag.example/figures/c.png) 所示，应先止血。'}</Markdown>,
    );

    expect(container.querySelectorAll('div.flex.flex-wrap')).toHaveLength(0);
    expect(container.querySelector('p img')).not.toBeNull();
  });

  it('opens the clicked image in the lightbox with every figure available', () => {
    render(<Markdown>{imageMarkdown}</Markdown>);

    fireEvent.click(screen.getByRole('button', { name: 'Preview 图3-2 加压包扎' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toBeNull();
    expect(screen.getByText('2 / 2')).toBeTruthy();
  });
});
