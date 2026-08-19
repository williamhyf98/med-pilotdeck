import { describe, expect, it } from 'vitest';
import { buildProcessToolSteps } from './processGrouping';

function toolMessage(toolName: string, toolInput: unknown) {
  return {
    id: `m-${toolName}`,
    type: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    isToolUse: true,
    toolName,
    toolInput,
    toolId: `t-${toolName}`,
    toolResult: null,
  } as any;
}

describe('buildProcessToolSteps skill target', () => {
  it('shows the skill name for read_skill tool steps', () => {
    const steps = buildProcessToolSteps([
      toolMessage('read_skill', JSON.stringify({ skillName: 'med-tools:med-case-report' })),
      toolMessage('read_file', JSON.stringify({ file_path: 'C:/data/a.xml' })),
    ]);
    expect(steps.length).toBe(2);
    const skillStep = steps.find((s) => s.toolName === 'read_skill');
    expect(skillStep?.detail).toBe('med-tools:med-case-report');
    const readStep = steps.find((s) => s.toolName === 'read_file');
    expect(readStep?.detail).toContain('a.xml');
  });
});
