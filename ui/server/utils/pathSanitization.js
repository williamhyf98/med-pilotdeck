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
    // Preserve only user-authored text and attachment names; server-created
    // metadata on that same message still needs redaction.
    if (value.kind === 'text' && value.role === 'user') {
        const out = {};
        seen.set(value, out);
        for (const [key, item] of Object.entries(value)) {
            if (key === 'content') out[key] = item;
            else if (key === 'attachments' && Array.isArray(item)) {
                out[key] = item.map((attachment) => attachment && typeof attachment === 'object'
                    ? { ...sanitizeValue(attachment, options, seen), name: attachment.name }
                    : sanitizeValue(attachment, options, seen));
            } else out[key] = sanitizeValue(item, options, seen);
        }
        return out;
    }
    const out = {};
    seen.set(value, out);
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeValue(item, options, seen);
    return out;
}

/** Keep a candidate path together until we know where it ends. */
export function createStreamingPathSanitizer(options, maxPending = 300) {
    const { pilotRoot, appRoot = defaultAppRoot(), hostHomes = defaultHostHomes() } = options;
    const prefixes = [...new Set([
        ...withRealpath(resolve(pilotRoot)),
        ...withRealpath(resolve(appRoot)),
        ...hostHomes.flatMap((home) => withRealpath(resolve(home))),
    ])].filter((p) => p !== '/');
    let pending = '';
    const sanitize = (text) => sanitizePaths(text, options);
    const isPrefix = (part) => prefixes.some((prefix) => prefix.startsWith(part));
    const candidateStart = (text) => {
        for (let i = 0; i < text.length; i += 1) {
            if (text[i] !== '/') continue;
            const suffix = text.slice(i);
            // A full path prefix must remain buffered until the following token ends.
            if (isPrefix(suffix) || prefixes.some((prefix) =>
                suffix.startsWith(prefix) && (suffix.length === prefix.length || /[^A-Za-z0-9._-]/.test(suffix[prefix.length])))) {
                return i;
            }
        }
        return -1;
    };
    return {
        push(chunk) {
            const text = pending + chunk;
            pending = '';
            // An unfinished token can begin before the last delimiter (e.g.
            // "path /root/file" split just after "/root/"). Walk back to the
            // last delimiter and retain only the candidate in that token.
            const delimiters = /[\s"'<>)}\]]/g;
            let boundary = -1;
            for (const match of text.matchAll(delimiters)) boundary = match.index;
            const start = candidateStart(text.slice(boundary + 1));
            if (start >= 0) {
                const index = boundary + 1 + start;
                pending = text.slice(index);
                if (pending.length > maxPending) {
                    pending = '';
                    return sanitize(text.slice(0, index)) + '[路径已隐藏]';
                }
                return sanitize(text.slice(0, index));
            }
            return sanitize(text);
        },
        flush() {
            const output = sanitize(pending);
            // An interrupted path prefix (e.g. "/data/pilot") is still
            // sensitive even when the complete configured root never arrived.
            const safe = output === pending && pending ? '[路径已隐藏]' : output;
            pending = '';
            return safe;
        },
        discard() { pending = ''; },
    };
}

/**
 * Wrap a `{ send }` writer so every outgoing frame is sanitized for `userId`.
 * Sanitization failures drop to a redacted frame rather than leaking the original.
 */
export function createSanitizingWriter(writer, options) {
    const streams = new Map();
    const sendSafe = (frame) => {
        try {
            return writer.send(sanitizeValue(frame, options));
        } catch {
            return writer.send({ kind: 'error', content: 'Output withheld: path sanitization failed.' });
        }
    };
    const keyOf = (frame) => `${frame.sessionId || ''}:${frame.subagentId || ''}:${frame.kind}`;
    const finish = (frame, discard = false) => {
        for (const [key, { sanitizer, template }] of streams) {
            if (!key.startsWith(`${frame.sessionId || ''}:`)) continue;
            streams.delete(key);
            const content = discard ? (sanitizer.discard(), '') : sanitizer.flush();
            if (content) sendSafe(template.kind === 'progress'
                ? { ...template, chunk: content }
                : { ...template, content });
        }
    };
    return new Proxy(writer, {
        get(target, prop, receiver) {
            if (prop === 'discardPending') return () => {
                for (const { sanitizer } of streams.values()) sanitizer.discard();
                streams.clear();
            };
            if (prop !== 'send') {
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }
            return (frame) => {
                if (frame?.kind === 'stream_delta' || frame?.kind === 'thinking') {
                    const key = keyOf(frame);
                    let state = streams.get(key);
                    if (!state) {
                        state = { sanitizer: createStreamingPathSanitizer(options), template: frame };
                        streams.set(key, state);
                    }
                    state.template = frame;
                    const content = state.sanitizer.push(String(frame.content ?? ''));
                    if (!content) return;
                    return sendSafe({ ...frame, content });
                }
                if (frame?.kind === 'stream_end') {
                    const key = `${frame.sessionId || ''}:${frame.subagentId || ''}:stream_delta`;
                    const state = streams.get(key);
                    if (state) {
                        streams.delete(key);
                        const content = state.sanitizer.flush();
                        if (content) sendSafe({ ...state.template, content });
                    }
                }
                if (frame?.kind === 'complete') finish(frame);
                if (frame?.kind === 'error' || frame?.kind === 'permission_cancelled') finish(frame, true);
                // Tool progress payloads may contain one stdout chunk per event.
                if (frame?.kind === 'progress' && typeof frame.chunk === 'string') {
                    const key = `${keyOf(frame)}:${frame.toolId || ''}`;
                    let state = streams.get(key);
                    if (!state) streams.set(key, state = { sanitizer: createStreamingPathSanitizer(options), template: frame });
                    state.template = frame;
                    const chunk = state.sanitizer.push(frame.chunk);
                    if (!chunk) return;
                    return sendSafe({ ...frame, chunk });
                }
                return sendSafe(frame);
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
