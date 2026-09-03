import { describe, expect, it } from 'vitest';
import { SYSTEM_PROJECT_TYPES } from './SystemProjectCreateDialog';

describe('SystemProjectCreateDialog project types', () => {
  it('only offers General Medicine while War Trauma is redesigned', () => {
    expect(SYSTEM_PROJECT_TYPES).toEqual([
      { id: 'general_medicine', label: '通用医学' },
    ]);
  });
});
