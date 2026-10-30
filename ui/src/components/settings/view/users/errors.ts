import type { ActionResult } from './useUsersAdmin';

type Translate = (key: string) => string;

const KNOWN_ERROR_CODES = new Set(['LAST_ADMIN', 'RESERVED_USERNAME', 'USERNAME_TAKEN', 'WEAK_CREDENTIALS']);

type Failure = Extract<ActionResult, { ok: false }>;

/** Maps a failed admin action to a localized message; unknown codes fall back to the generic text plus the server message. */
export function describeUserError(t: Translate, failure: Failure): string {
  if (KNOWN_ERROR_CODES.has(failure.code)) return t(`settingsPage.users.errors.${failure.code}`);
  const generic = t('settingsPage.users.errors.generic');
  return failure.message ? `${generic}: ${failure.message}` : generic;
}
