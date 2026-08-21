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

  it('summarizes pdf.sh make commands and surfaces the written PDF', () => {
    const command = 'mkdir -p "$PWD/exports" && bash /opt/skills/pdf/scripts/pdf.sh make --spec "$PWD/exports/spec.json" --out "$PWD/exports/战创伤救治方案.pdf"';
    const steps = buildProcessToolSteps([{
      id: 'm-bash',
      type: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isToolUse: true,
      toolName: 'bash',
      toolInput: JSON.stringify({
        command,
        description: 'Generate care plan PDF',
      }),
      toolId: 't-bash',
      toolResult: {
        content: [
          'BASH_RESULT[success][stdout_data]',
          'stdout:',
          '{"status":"ok","output":"/workspace/exports/战创伤救治方案.pdf","pages":4}',
        ].join('\n'),
        isError: false,
      },
    } as any]);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.title).toBe('Generate care plan PDF');
    expect(steps[0]?.target).toBe('pdf.sh make → 战创伤救治方案.pdf');
    expect(steps[0]?.detail).toBe(command);
    expect(steps[0]?.resultDetail).toBe('已写入 战创伤救治方案.pdf');
    expect(steps[0]?.phase).toBe('command');
  });

  it('shows pdf.sh existence errors instead of the raw bash banner', () => {
    const steps = buildProcessToolSteps([{
      id: 'm-bash-err',
      type: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isToolUse: true,
      toolName: 'Bash',
      toolInput: JSON.stringify({
        command: 'bash pdf.sh make --out exports/救治方案.pdf',
        description: 'Generate care plan PDF',
      }),
      toolId: 't-bash-err',
      toolResult: {
        content: [
          'Command exited with code 2: bash pdf.sh make --out exports/救治方案.pdf',
          'stderr:',
          '{"status":"error","error":"output already exists; pass --force to replace: exports/救治方案.pdf"}',
        ].join('\n'),
        isError: true,
      },
    } as any]);

    expect(steps[0]?.resultDetail).toContain('output already exists');
    expect(steps[0]?.resultDetail).not.toContain('Command exited with code');
  });
});
