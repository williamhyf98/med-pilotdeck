// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TraumaTurnForm from './TraumaTurnForm';

afterEach(cleanup);

describe('TraumaTurnForm', () => {
  it('requires a narrative or measured vital and does not count the selected stage', async () => {
    const submit = vi.fn();
    render(<TraumaTurnForm onSubmit={submit} />);

    fireEvent.change(screen.getByLabelText('救治级别'), {
      target: { value: 'advanced_first_aid' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交本轮信息' }));

    expect(await screen.findByText('请至少填写一段叙述或一项本轮实测生命体征')).not.toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('renders every field as one labelled row inside the dialog bubble', () => {
    render(<TraumaTurnForm onSubmit={vi.fn()} />);

    const bubble = screen.getByRole('form', { name: '本轮伤情录入' });
    for (const label of ['救治级别', '伤情描述', '已做处置', '后送条件', '补充说明', '生命体征']) {
      expect(bubble.textContent).toContain(`${label}：`);
    }

    const stage = screen.getByLabelText('救治级别') as HTMLSelectElement;
    expect(stage.tagName).toBe('SELECT');
    expect(stage.value).toBe('');
    expect(Array.from(stage.options).map((option) => option.textContent)).toEqual([
      '由系统判定',
      '初级急救',
      '高级急救',
      '紧急处置',
      '外科复苏',
    ]);
  });

  it('explains each empty row with a hint and an example', () => {
    render(<TraumaTurnForm onSubmit={vi.fn()} />);

    expect(screen.getByLabelText('伤情描述').getAttribute('placeholder'))
      .toBe('描述受伤部位、致伤原因与当前表现。如：爆炸胸部受创，右小腿伤口渗血，意识清楚可应答。');
    expect(screen.getByLabelText('已做处置').getAttribute('placeholder'))
      .toBe('已完成的救治措施、执行进度与效果。如：已于右大腿根部扎止血带，出血明显减少');
    expect(screen.getByLabelText('后送条件').getAttribute('placeholder'))
      .toBe('后送的可行性，涵盖交通运力、道路与天气、伤情稳定性等。如：有救护车，但伤口仍间断出血');
    expect(screen.getByLabelText('补充说明').getAttribute('placeholder'))
      .toBe('其他有价值的信息。如：现场共 3 名伤员，可用血制品有限');
    expect(screen.getByText('可选填，本轮未测的项留空即可')).not.toBeNull();
  });

  it('drops the character counters and the carried-over vital hints', () => {
    render(<TraumaTurnForm onSubmit={vi.fn()} />);

    expect(screen.queryByText('0/1000')).toBeNull();
    expect(screen.queryByText(/上次 R/)).toBeNull();
    expect(screen.queryByText('暂无历史实测')).toBeNull();
    expect(screen.queryByRole('button', { name: /沿用/ })).toBeNull();
  });

  it('validates vital ranges and narrative lengths inline', async () => {
    render(<TraumaTurnForm onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('呼吸频率'), { target: { value: '81' } });
    fireEvent.change(screen.getByLabelText('体温'), { target: { value: '36.55' } });
    fireEvent.change(screen.getByLabelText('伤情描述'), {
      target: { value: '伤'.repeat(1001) },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交本轮信息' }));

    expect(await screen.findByText('请输入 0–80 的整数')).not.toBeNull();
    expect(screen.getByText('请输入 20–45 且最多一位小数的数值')).not.toBeNull();
    expect(screen.getByText('伤情描述不能超过 1000 字')).not.toBeNull();
    const injury = screen.getByLabelText('伤情描述');
    expect(injury.getAttribute('maxlength')).toBe('1000');
    expect(injury.getAttribute('aria-describedby')).toContain('trauma-injuryNarrative-error');
    expect(document.getElementById('trauma-injuryNarrative-error')?.textContent)
      .toBe('伤情描述不能超过 1000 字');
  });

  it('keeps the narrative length limits on every row', () => {
    render(<TraumaTurnForm onSubmit={vi.fn()} />);

    expect(screen.getByLabelText('已做处置').getAttribute('maxlength')).toBe('800');
    expect(screen.getByLabelText('后送条件').getAttribute('maxlength')).toBe('500');
    expect(screen.getByLabelText('补充说明').getAttribute('maxlength')).toBe('500');
  });

  it('submits only populated optional values', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<TraumaTurnForm onSubmit={submit} />);

    fireEvent.change(screen.getByLabelText('救治级别'), {
      target: { value: 'surgical_resuscitation' },
    });
    fireEvent.change(screen.getByLabelText('伤情描述'), {
      target: { value: '腹部压痛加重' },
    });
    fireEvent.change(screen.getByLabelText('收缩压'), { target: { value: '88' } });
    fireEvent.change(screen.getByLabelText('体温'), { target: { value: '36.5' } });
    fireEvent.click(screen.getByRole('button', { name: '提交本轮信息' }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit).toHaveBeenCalledWith({
      statedSubStage: 'surgical_resuscitation',
      injuryNarrative: '腹部压痛加重',
      treatmentNarrative: '',
      evacuationNarrative: '',
      note: '',
      vitals: {
        systolicBloodPressure: 88,
        temperature: 36.5,
      },
    });
    expect((screen.getByLabelText('伤情描述') as HTMLTextAreaElement).value)
      .toBe('腹部压痛加重');
  });

  it('preserves entered values when submission rejects', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('enqueue failed'));
    render(<TraumaTurnForm onSubmit={submit} />);
    fireEvent.change(screen.getByLabelText('伤情描述'), {
      target: { value: '待重试的伤情' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交本轮信息' }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect((screen.getByLabelText('伤情描述') as HTMLTextAreaElement).value)
      .toBe('待重试的伤情');
  });
});
