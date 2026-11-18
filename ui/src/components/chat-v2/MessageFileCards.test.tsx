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

it('maps a pre-migration attachment path back into the current project', () => {
  const onBrowse = vi.fn();
  const project = {
    name: 'project-a',
    fullPath: '/Users/william/.pilotdeck/users/1/workspaces/general_med/project-a',
  } as Project;

  render(
    <UserAttachmentCards
      attachments={[{
        name: 'scan.dcm',
        path: '/Users/william/.pilotdeck/workspaces/general_med/project-a/inbox/scan.dcm',
      }]}
      project={project}
      onBrowse={onBrowse}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'scan.dcm' }));
  expect(onBrowse).toHaveBeenCalledWith('inbox/scan.dcm');
});

it('shows a referenced folder without offering a file preview', () => {
  const onBrowse = vi.fn();
  render(
    <UserAttachmentCards
      attachments={[{
        name: 'case-001',
        path: 'inbox/case-001',
        metadata: { workspaceFileMention: true, workspaceFileMentionKind: 'directory' },
      }]}
      project={{ name: 'project-a', fullPath: '/workspace/project-a' } as Project}
      onBrowse={onBrowse}
    />,
  );

  const folder = screen.getByRole('button', { name: 'inbox/case-001' });
  expect((folder as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('DIR')).not.toBeNull();
  fireEvent.click(folder);
  expect(onBrowse).not.toHaveBeenCalled();
});
