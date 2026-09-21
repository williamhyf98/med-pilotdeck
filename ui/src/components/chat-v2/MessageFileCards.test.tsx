// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UserAttachmentCards } from './MessageFileCards';
import type { Project } from '../../types/app';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options: { defaultValue: string; name?: string }) => options.defaultValue.replace('{{name}}', options.name || '') }),
}));
afterEach(cleanup);

it('does not turn an upload placeholder filename into a preview or download path', () => {
  const onBrowse = vi.fn();
  const project = { name: 'project', fullPath: '/project' } as Project;
  const { rerender } = render(<UserAttachmentCards attachments={[{ name: 'scan.dcm' }]} project={project} onBrowse={onBrowse} />);
  fireEvent.click(screen.getByRole('button', { name: 'scan.dcm' }));
  expect(onBrowse).not.toHaveBeenCalled();
  expect(screen.queryByRole('link')).toBeNull();
  rerender(<UserAttachmentCards attachments={[{ name: 'scan.dcm', path: '/project/inbox/upload/scan.dcm' }]} project={project} onBrowse={onBrowse} />);
  fireEvent.click(screen.getByRole('button', { name: 'scan.dcm' }));
  expect(onBrowse).toHaveBeenCalledWith('inbox/upload/scan.dcm');
});
