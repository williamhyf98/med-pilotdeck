import { describe, expect, it } from 'vitest';
import { sanitizePaths, sanitizeValue } from './pathSanitization.js';

const root = '/data/pilotdeck';
const app = '/opt/pilotdeck-app';
const opts = { userId: 123, pilotRoot: root, appRoot: app, hostHomes: ['/home/deploy', '/root'] };

describe('sanitizePaths', () => {
    it('maps the current user home to ~', () => {
        expect(sanitizePaths('/data/pilotdeck/users/123/projects/p1/file.txt', opts)).toBe('~/projects/p1/file.txt');
        expect(sanitizePaths('/data/pilotdeck/users/123', opts)).toBe('~');
    });

    it('redacts other users, including ids that share a prefix with the current id', () => {
        expect(sanitizePaths('/data/pilotdeck/users/456/projects/p2', opts)).toBe('@users/<REDACTED>/projects/p2');
        expect(sanitizePaths('/data/pilotdeck/users/1234/x', opts)).toBe('@users/<REDACTED>/x');
        expect(sanitizePaths('/data/pilotdeck/users/12/x', opts)).toBe('@users/<REDACTED>/x');
    });

    it('maps system, plugins and the root itself, mid-line as well as at line start', () => {
        expect(sanitizePaths('/data/pilotdeck/system/auth.db', opts)).toBe('@system/auth.db');
        expect(sanitizePaths('plugins -> /data/pilotdeck/plugins', opts)).toBe('plugins -> @plugins');
        expect(sanitizePaths('cat /data/pilotdeck/pilotdeck.yaml', opts)).toBe('cat @root/pilotdeck.yaml');
    });

    it('maps the app install directory so bundled skill paths do not leak it', () => {
        expect(sanitizePaths('bash /opt/pilotdeck-app/skills/pdf/scripts/pdf.sh make', opts))
            .toBe('bash @app/skills/pdf/scripts/pdf.sh make');
    });

    it('handles multi-line output, quotes and trailing punctuation', () => {
        const text = 'a.txt\n/data/pilotdeck/users/123/b.txt\n"/data/pilotdeck/users/789/c.txt".\n(/data/pilotdeck/system)';
        const out = sanitizePaths(text, opts);
        expect(out).toBe('a.txt\n~/b.txt\n"@users/<REDACTED>/c.txt".\n(@system)');
    });

    it('does not touch look-alike prefixes', () => {
        expect(sanitizePaths('/data/pilotdeck-backup/users/1/x', opts)).toBe('/data/pilotdeck-backup/users/1/x');
        expect(sanitizePaths('/data/pilotdeckX/system', opts)).toBe('/data/pilotdeckX/system');
    });

    it('masks configured host home directories but leaves unrelated text alone', () => {
        expect(sanitizePaths('error at /home/deploy/.cache/x and /root/y', opts)).toBe('error at @host/.cache/x and @host/y');
        expect(sanitizePaths('see /usr/bin/python3 and a/b/c', opts)).toBe('see /usr/bin/python3 and a/b/c');
    });

    it('is idempotent and tolerant of non-strings', () => {
        const once = sanitizePaths('/data/pilotdeck/users/123/a /data/pilotdeck/users/9/b', opts);
        expect(sanitizePaths(once, opts)).toBe(once);
        expect(sanitizePaths(undefined, opts)).toBeUndefined();
        expect(sanitizePaths(42, opts)).toBe(42);
    });

    it('matches regex-special characters in the root literally', () => {
        const o = { userId: 1, pilotRoot: '/data/pi+lot(1)', appRoot: app, hostHomes: [] };
        expect(sanitizePaths('/data/pi+lot(1)/users/1/x', o)).toBe('~/x');
        expect(sanitizePaths('/data/piilot1/users/1/x', o)).toBe('/data/piilot1/users/1/x');
    });
});

describe('sanitizeValue', () => {
    it('cleans strings deeply inside frames without mutating the input', () => {
        const frame = { kind: 'tool_result', content: 'ls /data/pilotdeck/users/456', nested: [{ p: '/data/pilotdeck/system/auth.db' }], n: 3 };
        const out = sanitizeValue(frame, opts);
        expect(out).toEqual({ kind: 'tool_result', content: 'ls @users/<REDACTED>', nested: [{ p: '@system/auth.db' }], n: 3 });
        expect(frame.content).toBe('ls /data/pilotdeck/users/456');
    });

    it('survives cycles', () => {
        const a = { s: '/data/pilotdeck/system' };
        a.self = a;
        expect(sanitizeValue(a, opts).s).toBe('@system');
    });
});
