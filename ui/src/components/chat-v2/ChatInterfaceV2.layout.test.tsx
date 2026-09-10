// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatInterfaceLayout } from './ChatInterfaceV2';
import { PermissionRequestsSlot } from './ComposerV2';

vi.mock('../chat/view/subcomponents/PermissionRequestsBanner', () => ({
  default: ({
    handlePermissionDecision,
  }: {
    handlePermissionDecision: (requestId: string, decision: { allow: boolean }) => void;
  }) => (
    <button
      type="button"
      onClick={() => handlePermissionDecision('placement-request', { allow: true })}
    >
      确认救治级别
    </button>
  ),
}));

afterEach(cleanup);

describe('ChatInterfaceLayout', () => {
  it('always renders messages and omits the composer in runtime-only mode', () => {
    const decide = vi.fn();
    render(
      <ChatInterfaceLayout
        hideComposer
        isWelcomeMode
        compact={false}
        messagePane={<div>runtime messages</div>}
        composerSlot={(
          <form>
            <textarea aria-label="ordinary chat input" />
            <button type="submit">normal submit</button>
          </form>
        )}
        permissionSlot={(
          <PermissionRequestsSlot
            pendingPermissionRequests={[{
              requestId: 'placement-request',
              toolName: 'ask_user_question',
              isElicitation: true,
            }]}
            handlePermissionDecision={decide}
            handleGrantToolPermission={() => ({ success: true })}
          />
        )}
        hiddenComposerNotice="战创伤录入请切换到对话工作区"
        welcome={<div>welcome shortcut</div>}
      />,
    );

    expect(screen.getByText('runtime messages')).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: 'ordinary chat input' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'normal submit' })).toBeNull();
    expect(screen.queryByText('welcome shortcut')).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('战创伤录入请切换到对话工作区');
    fireEvent.click(screen.getByRole('button', { name: '确认救治级别' }));
    expect(decide).toHaveBeenCalledWith('placement-request', { allow: true });
  });
});
