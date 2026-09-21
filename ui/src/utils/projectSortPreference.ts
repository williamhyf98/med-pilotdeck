export type ProjectSortPreference = 'date' | 'name';

/** Apply the new default once; later explicit choices survive reloads. */
export function readProjectSortPreference(): ProjectSortPreference {
  try {
    const raw = localStorage.getItem('pilotdeck-settings');
    const value = raw ? JSON.parse(raw) : {};
    const settings = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    if (settings.projectSortDefaultVersion !== 1) {
      localStorage.setItem('pilotdeck-settings', JSON.stringify({
        ...settings,
        projectSortOrder: 'date',
        projectSortDefaultVersion: 1,
      }));
      return 'date';
    }
    return settings.projectSortOrder === 'name' ? 'name' : 'date';
  } catch {
    return 'date';
  }
}
