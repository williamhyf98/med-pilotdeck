/**
 * Client-side path hygiene. The server already sanitizes agent output in
 * multi-user mode; this is the second line for text the browser builds itself
 * (tool-call summaries, terminal banners) and a guard against anything that slips
 * through. The browser does not know the server's data root, so it recognises the
 * stable `<anything>/users/<id>` layout instead of a fixed prefix.
 *
 *   .../users/<current id>  -> ~
 *   .../users/<other id>    -> @users/<REDACTED>
 */
const USER_HOME_PATTERN = /(?:\/[^/\s"'`<>()[\]{}|;,*?]+|[A-Za-z]:\\[^\\\s"'`<>]+)*?[/\\]users[/\\]([A-Za-z0-9_-]+)(?=$|[^A-Za-z0-9_-])/g;

export function sanitizePathsClient(
  text: string,
  userId: string | number | null | undefined,
): string {
  if (typeof text !== 'string' || !text) return text;
  const current = userId === null || userId === undefined ? '' : String(userId);
  return text.replace(USER_HOME_PATTERN, (_match, id: string) =>
    current && id === current ? '~' : '@users/<REDACTED>',
  );
}

/**
 * User id to sanitize for, or `undefined` when the browser should leave paths alone.
 * No-login and platform deployments use the placeholder ids `local` / `platform`;
 * there the host paths belong to the one operator, so nothing is hidden. Accepts a
 * bare id (as kept by safeStorage) or an auth user object.
 */
export function sanitizeUserIdFor(
  user: string | number | { id: string | number } | null | undefined,
): string | number | undefined {
  const id = user !== null && typeof user === 'object' ? user.id : user;
  if (id === null || id === undefined || id === '') return undefined;
  if (id === 'local' || id === 'platform') return undefined;
  return id;
}
