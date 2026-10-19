/**
 * Replace absolute filesystem locations in text with semantic ones, so the model
 * output and tool results shown to a user never reveal the server layout or other
 * users' directories. Backend counterpart of the frontend sanitizer.
 *
 * Rules (first match wins at a given position, longest/most specific first):
 *   <root>/users/<current>   -> ~
 *   <root>/users/<other>     -> @users/<REDACTED>
 *   <root>/system            -> @system
 *   <root>/plugins           -> @plugins
 *   <root>                   -> @root
 *   <appRoot>                -> @app
 *   configured host homes    -> @host
 *
 * A prefix only matches at a path boundary, so `/data/pilotdeck-backup` and user
 * ids sharing a prefix (`12` vs `123`) are left alone.
 */
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOUNDARY = '(?=$|[^A-Za-z0-9._-])';

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withRealpath(p) {
    const forms = [p];
    try {
        const real = realpathSync(p);
        if (real !== p) forms.push(real);
    } catch { /* path may not exist */ }
    return forms;
}

function defaultAppRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function defaultHostHomes() {
    const homes = new Set(['/root']);
    try { homes.add(homedir()); } catch { /* ignore */ }
    return [...homes].filter((home) => home && home !== '/');
}

/** Alternation of every spelling (raw and realpath) of a directory. */
function dirPattern(dir) {
    return withRealpath(resolve(dir)).map(escapeRegex).join('|');
}

export function sanitizePaths(text, { userId, pilotRoot, appRoot = defaultAppRoot(), hostHomes = defaultHostHomes() } = {}) {
    if (typeof text !== 'string' || !text || !pilotRoot) return text;
    const root = resolve(pilotRoot);
    const rootPattern = dirPattern(root);
    const id = String(userId);

    const rules = [
        [new RegExp(`(?:${rootPattern})/users/([^/\\s"'<>)\\]]+)(?=$|[^A-Za-z0-9._-]|/)`, 'g'),
            (match, captured) => (captured === id ? '~' : '@users/<REDACTED>')],
        [new RegExp(`(?:${rootPattern})/system${BOUNDARY}`, 'g'), '@system'],
        [new RegExp(`(?:${rootPattern})/plugins${BOUNDARY}`, 'g'), '@plugins'],
        [new RegExp(`(?:${rootPattern})${BOUNDARY}`, 'g'), '@root'],
        [new RegExp(`(?:${dirPattern(appRoot)})${BOUNDARY}`, 'g'), '@app'],
        ...hostHomes.filter(Boolean).map((home) => [new RegExp(`(?:${dirPattern(home)})${BOUNDARY}`, 'g'), '@host']),
    ];

    let result = text;
    for (const [pattern, replacement] of rules) result = result.replace(pattern, replacement);

    // Path compression: ~/xxx/yyy/zzz.ext → zzz.ext
    // Only process paths already replaced to ~ prefix, preserve filename
    result = result.replace(/~\/[^\s"'<>)}\]]*?\/([^\s"'<>)}\]/]+\.[a-zA-Z0-9]+)/g, '$1');

    return result;
}

/** Deep-clone `value`, sanitizing every string. Safe on cyclic input; never mutates. */
export function sanitizeValue(value, options, seen = new WeakMap()) {
    if (typeof value === 'string') return sanitizePaths(value, options);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
        const out = [];
        seen.set(value, out);
        for (const item of value) out.push(sanitizeValue(item, options, seen));
        return out;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    seen.set(value, out);
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeValue(item, options, seen);
    return out;
}

/**
 * Wrap a `{ send }` writer so every outgoing frame is sanitized for `userId`.
 * Sanitization failures drop to a redacted frame rather than leaking the original.
 */
export function createSanitizingWriter(writer, options) {
    return new Proxy(writer, {
        get(target, prop, receiver) {
            if (prop !== 'send') {
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }
            return (frame) => {
                let safe;
                try {
                    safe = sanitizeValue(frame, options);
                } catch {
                    safe = { kind: 'error', content: 'Output withheld: path sanitization failed.' };
                }
                return target.send(safe);
            };
        },
    });
}

/**
 * Sanitization options for the current request scope, or `null` when frames must
 * stay untouched (single-user no-login mode, where paths are the user's own).
 * Lazy-imports keep this module free of server-wide side effects for unit tests.
 */
export function scopedSanitizeOptions({ disableLocalAuth, userId, pilotRoot }) {
    if (disableLocalAuth) return null;
    return { userId, pilotRoot };
}
