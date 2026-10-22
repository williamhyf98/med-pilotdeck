let pending: Promise<unknown> = Promise.resolve();

export function enqueueUserPreferenceSave(save: () => Promise<unknown>) {
  pending = pending.catch(() => {}).then(save);
  return pending;
}

export async function flushUserPreferenceSaves() {
  await pending.catch(() => {});
}

export const USER_PREFERENCES_FLUSH_EVENT = 'pilotdeck:ui-preferences-flush';
