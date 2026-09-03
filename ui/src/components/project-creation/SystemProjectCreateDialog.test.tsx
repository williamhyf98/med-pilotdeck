import { describe, expect, it } from 'vitest';
import { SYSTEM_PROJECT_TYPES } from './SystemProjectCreateDialog';

describe('SystemProjectCreateDialog project types', () => {
  it('offers both supported medical project types', () => {
    expect(SYSTEM_PROJECT_TYPES).toEqual([
      { id: 'general_medicine', label: '通用医学' },
      { id: 'war_trauma', label: '战创伤医学' },
    ]);
  });
});
