// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { getMenuItems } from './SettingsSidebar';

const flatKeys = (isAdmin: boolean, authDisabled = false) =>
  getMenuItems(isAdmin, authDisabled).flatMap((i) => (i.children ? i.children.map((c) => c.key) : [i.key]));

describe('settings menu by role', () => {
  it('normal users see only account/general/agentMemory', () => {
    expect(flatKeys(false)).toEqual(['account', 'general', 'agentMemory']);
  });

  it('admins see operator settings and users', () => {
    expect(flatKeys(true)).toEqual(
      expect.arrayContaining(['account', 'users', 'modelPool', 'advanced', 'officePreview']),
    );
  });

  it('admin menu keeps the original order with account first and users last', () => {
    expect(flatKeys(true)).toEqual([
      'account',
      'general',
      'modelPool',
      'agentModel',
      'agentRoute',
      'agentMemory',
      'officePreview',
      'advanced',
      'users',
    ]);
  });

  it('hides the user-management page in no-login mode (spec 8)', () => {
    expect(flatKeys(true, true)).not.toContain('users');
    // everything else the admin menu offers is still there
    expect(flatKeys(true, true)).toEqual(flatKeys(true).filter((k) => k !== 'users'));
    expect(flatKeys(false, true)).toEqual(['account', 'general', 'agentMemory']);
  });
});
