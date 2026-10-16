import { describe, expect, it } from 'vitest';
import { buildProcessToolSteps } from './processGrouping';

function bash(command: string, result?: string) {
  return {
    id: 'm-bash',
    type: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    isToolUse: true,
    toolName: 'bash',
    toolInput: JSON.stringify({ command }),
    toolId: 't-bash',
    toolResult: result === undefined ? null : { content: result, isError: false },
  } as any;
}

describe('buildProcessToolSteps path sanitization', () => {
  const command = 'ls -la /data/pilotdeck/users/7/workspaces/p1 /data/pilotdeck/users/8/workspaces/p2';

  it('hides the user-specific part of paths when a user id is given', () => {
    const [step] = buildProcessToolSteps([bash(command)], { sanitizeForUserId: 7 });
    expect(step.detail).toBe('ls -la ~/workspaces/p1 @users/<REDACTED>/workspaces/p2');
    expect(step.target).not.toContain('/data/pilotdeck');
    expect(JSON.stringify(step)).not.toContain('users/8');
  });

  it('cleans the result detail too', () => {
    const [step] = buildProcessToolSteps(
      [{ ...bash('cat x', 'No such file: /data/pilotdeck/users/9/secret.md'), toolName: 'bash' }],
      { sanitizeForUserId: 7 },
    );
    expect(step.resultDetail ?? '').not.toContain('users/9');
  });

  it('leaves paths untouched when no user id is given (no-login mode)', () => {
    const [step] = buildProcessToolSteps([bash(command)]);
    expect(step.detail).toBe(command);
    const [explicitNull] = buildProcessToolSteps([bash(command)], { sanitizeForUserId: null });
    expect(explicitNull.detail).toBe(command);
  });
});
