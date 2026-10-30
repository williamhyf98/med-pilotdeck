import { describe, expect, it, vi } from 'vitest';
import { startSessionCommand } from './sessionLauncher';

describe('startSessionCommand trauma form contract', () => {
  it('serializes traumaForm in command options without putting JSON in visible text', () => {
    const sendMessage = vi.fn();
    const traumaForm = {
      statedSubStage: 'primary_first_aid' as const,
      injuryNarrative: '右小腿开放伤',
      treatmentNarrative: '',
      evacuationNarrative: '',
      note: '',
      vitals: { heartRate: 118 },
    };

    const activated = startSessionCommand({
      sendMessage,
      selectedProject: {
        name: 'trauma_med-demo',
        displayName: '战创伤演练',
        fullPath: '/workspace/trauma',
      },
      sessionId: 'web:s1',
      command: '战创伤推演：初级急救；伤情：右小腿开放伤；心率 118 次/分',
      userVisibleInput: '初级急救 · 伤情：右小腿开放伤 · 心率 118 次/分',
      runId: 'run-trauma-1',
      traumaForm,
    });

    expect(activated).toBe('web:s1');
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pilotdeck-command',
      options: expect.objectContaining({
        sessionId: 'web:s1',
        resume: true,
        runId: 'run-trauma-1',
        traumaForm,
        userVisibleInput: '初级急救 · 伤情：右小腿开放伤 · 心率 118 次/分',
      }),
    }));
    expect(JSON.stringify(sendMessage.mock.calls[0]?.[0].options.userVisibleInput))
      .not.toContain('injuryNarrative');
  });
});
