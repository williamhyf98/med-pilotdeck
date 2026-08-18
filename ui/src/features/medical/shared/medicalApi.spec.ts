import { describe, expect, it } from 'vitest';
import { parseTraumaResultSections } from './medicalApi';

describe('parseTraumaResultSections', () => {
  it('splits the military five-section response without depending on HTML', () => {
    const parsed = parseTraumaResultSections([
      '### 一、图像/影像判读',
      '可见左下肢开放性损伤。',
      '### 二、阶段处置（野战分类场）',
      '立即复评并控制致命性出血。',
      '### 三、特异处置',
      '固定患肢并记录远端循环。',
      '### 四、分类/伤标/后送/交接',
      '优先后送并完整交接止血措施。',
      '### 五、安全禁忌',
      '禁止盲目探查创口。',
    ].join('\n'));

    expect(parsed).toEqual({
      imaging: '可见左下肢开放性损伤。',
      'stage-action': '立即复评并控制致命性出血。',
      'specific-action': '固定患肢并记录远端循环。',
      evacuation: '优先后送并完整交接止血措施。',
      safety: '禁止盲目探查创口。',
    });
  });

  it('keeps unstructured partial output visible while streaming', () => {
    expect(parseTraumaResultSections('正在分析上传资料')).toMatchObject({
      imaging: '正在分析上传资料',
    });
  });
});
