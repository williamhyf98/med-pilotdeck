// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import XmlDocumentPreview from './XmlDocumentPreview';

afterEach(cleanup);
it('renders negative clinical findings as text, never as executable markup', () => {
  const content = '<ClinicalDocument><title>入院记录</title><component><section><title>既往史</title><entry><observation><code displayName="过敏史"/><value>无</value></observation></entry><text>&lt;img src=x onerror=alert(1)&gt;</text></section></component></ClinicalDocument>';
  const { container } = render(<XmlDocumentPreview content={content} mode="content" onSource={() => {}} />);
  expect(screen.getByRole('heading', { name: '入院记录' })).toBeTruthy();
  expect(screen.getByText('无')).toBeTruthy();
  expect(container.querySelector('img')).toBeNull();
});
it('keeps unknown attributes and long waveform data available on demand', () => {
  const data = '123 '.repeat(200);
  render(<XmlDocumentPreview content={`<custom><digits unit="uV">${data}</digits></custom>`} mode="structure" onSource={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'digits' }));
  expect(screen.getByText('uV')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /展开全部/ }));
  expect(screen.getByRole('button', { name: '收起' })).toBeTruthy();
});
it('offers source view for malformed input', () => {
  const onSource = vi.fn();
  render(<XmlDocumentPreview content="<broken>" mode="content" onSource={onSource} />);
  fireEvent.click(screen.getByRole('button', { name: '查看源码' }));
  expect(onSource).toHaveBeenCalledOnce();
});
