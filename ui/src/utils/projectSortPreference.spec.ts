import { beforeEach, describe, expect, it } from 'vitest';
import { readProjectSortPreference } from './projectSortPreference';

describe('project sorting preference', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to recent activity on first startup and reload', () => {
    expect(readProjectSortPreference()).toBe('date');
    expect(readProjectSortPreference()).toBe('date');
  });

  it('migrates old alphabetical defaults without losing other settings', () => {
    localStorage.setItem('anon:pilotdeck-settings', JSON.stringify({ projectSortOrder: 'name', allowedTools: ['Read'] }));
    expect(readProjectSortPreference()).toBe('date');
    expect(JSON.parse(localStorage.getItem('anon:pilotdeck-settings')!).allowedTools).toEqual(['Read']);
  });

  it('preserves explicit choices made after migration', () => {
    readProjectSortPreference();
    const settings = JSON.parse(localStorage.getItem('anon:pilotdeck-settings')!);
    localStorage.setItem('anon:pilotdeck-settings', JSON.stringify({ ...settings, projectSortOrder: 'name' }));
    expect(readProjectSortPreference()).toBe('name');
  });

  it('falls back to recent activity for invalid stored settings', () => {
    localStorage.setItem('anon:pilotdeck-settings', 'invalid');
    expect(readProjectSortPreference()).toBe('date');
  });
});
