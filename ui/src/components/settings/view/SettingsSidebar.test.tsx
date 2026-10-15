// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { getMenuItems } from './SettingsSidebar';

const flatKeys = (isAdmin: boolean) =>
  getMenuItems(isAdmin).flatMap((i) => (i.children ? i.children.map((c) => c.key) : [i.key]));

describe('settings menu by role', () => {
  it('normal users see only account/general/agentMemory/privacy', () => {
    expect(flatKeys(false)).toEqual(['account', 'general', 'agentMemory', 'privacy']);
  });

  it('admins see everything including users', () => {
    expect(flatKeys(true)).toEqual(
      expect.arrayContaining(['account', 'users', 'modelPool', 'mcpServers', 'advanced', 'about']),
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
      'agentResident',
      'agentSchedule',
      'mcpServers',
      'officePreview',
      'privacy',
      'advanced',
      'about',
      'users',
    ]);
  });
});
