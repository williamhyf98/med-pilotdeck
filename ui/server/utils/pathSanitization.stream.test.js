import { describe, expect, it } from 'vitest';
import { createSanitizingWriter, createStreamingPathSanitizer, sanitizePaths } from './pathSanitization.js';

const opts = { userId: '2', pilotRoot: '/data/pilotdeck', appRoot: '/opt/app', hostHomes: ['/home/doctor'] };
const text = '问诊 /data/pilotdeck/users/3/workspaces/secret.txt 与 /data/pilotdeck/users/2/workspaces/my.txt 结束';

describe('fragmented path output', () => {
    it.each([1, 3, 6, 17, 100])('handles chunks of %i chars with no partial path leak', (size) => {
        const sanitizer = createStreamingPathSanitizer(opts);
        let output = '';
        for (let i = 0; i < text.length; i += size) {
            output += sanitizer.push(text.slice(i, i + size));
            expect(output).not.toContain('/data/pilotdeck');
        }
        output += sanitizer.flush();
        expect(output).toBe(sanitizePaths(text, opts));
    });

    it('redacts an unterminated overlong token and discards interrupted content', () => {
        const sanitizer = createStreamingPathSanitizer(opts, 30);
        expect(sanitizer.push('/data/pilotdeck/users/3/' + 'x'.repeat(70))).toContain('[路径已隐藏]');
        expect(sanitizer.flush()).toBe('');
        sanitizer.push('/data/pilot');
        sanitizer.discard();
        expect(sanitizer.flush()).toBe('');
    });

    it('flushes thinking, assistant text and tool progress on completion', () => {
        const frames = [];
        const writer = createSanitizingWriter({ send: (frame) => frames.push(frame) }, opts);
        for (const chunk of ['/data/pilot', 'deck/users/3/secret.txt']) {
            writer.send({ kind: 'stream_delta', sessionId: 'a', content: chunk });
            writer.send({ kind: 'thinking', sessionId: 'a', content: chunk });
            writer.send({ kind: 'progress', sessionId: 'a', toolId: 'bash', chunk });
        }
        expect(JSON.stringify(frames)).not.toContain('/data/pilotdeck');
        writer.send({ kind: 'complete', sessionId: 'a' });
        expect(JSON.stringify(frames)).not.toContain('/data/pilotdeck');
        expect(frames.some((f) => f.kind === 'stream_delta' && f.content?.includes('@users/<REDACTED>'))).toBe(true);
        expect(frames.some((f) => f.kind === 'progress' && f.chunk?.includes('@users/<REDACTED>'))).toBe(true);
    });

    it('flushes assistant text before stream_end and keeps subagent streams independent', () => {
        const frames = [];
        const writer = createSanitizingWriter({ send: (frame) => frames.push(frame) }, opts);
        writer.send({ kind: 'stream_delta', sessionId: 'a', subagentId: 'first', content: '/data/pilot' });
        writer.send({ kind: 'stream_delta', sessionId: 'a', subagentId: 'second', content: '/data/pilot' });
        writer.send({ kind: 'stream_delta', sessionId: 'a', content: '/data/pilot' });
        writer.send({ kind: 'stream_delta', sessionId: 'a', subagentId: 'first', content: 'deck/users/3/private' });
        writer.send({ kind: 'stream_end', sessionId: 'a', subagentId: 'first' });
        expect(frames.some((f) => f.subagentId === 'first' && f.content === '@users/<REDACTED>/private')).toBe(true);
        expect(frames.some((f) => f.subagentId === 'second' && f.kind === 'stream_delta')).toBe(false);
        writer.send({ kind: 'complete', sessionId: 'a' });
        expect(JSON.stringify(frames)).not.toContain('/data/pilotdeck');
        expect(frames.some((f) => f.subagentId === 'second' && f.content === '[路径已隐藏]')).toBe(true);
    });

    it('discards withheld bytes after an error and never flushes another session', () => {
        const frames = [];
        const writer = createSanitizingWriter({ send: (frame) => frames.push(frame) }, opts);
        writer.send({ kind: 'stream_delta', sessionId: 'a', content: '/data/pilot' });
        writer.send({ kind: 'stream_delta', sessionId: 'b', content: '/data/pilot' });
        writer.send({ kind: 'error', sessionId: 'a', content: 'failed' });
        writer.send({ kind: 'complete', sessionId: 'b' });
        expect(frames.some((f) => f.sessionId === 'a' && f.kind === 'stream_delta')).toBe(false);
        expect(frames.some((f) => f.sessionId === 'b' && f.content === '[路径已隐藏]')).toBe(true);
    });

    it('releases a completed long path only as a redacted token', () => {
        const sanitizer = createStreamingPathSanitizer(opts);
        const leaked = sanitizer.push('/data/pilotdeck/users/3/' + 'x'.repeat(320));
        expect(leaked).not.toContain('/data/pilotdeck');
        expect(leaked).toContain('[路径已隐藏]');
        expect(sanitizer.flush()).toBe('');
    });

    it('discards pending text if the gateway closes without a terminal frame', () => {
        const frames = [];
        const writer = createSanitizingWriter({ send: (frame) => frames.push(frame) }, opts);
        writer.send({ kind: 'stream_delta', sessionId: 'a', content: '/data/pilot' });
        writer.discardPending();
        writer.send({ kind: 'complete', sessionId: 'a' });
        expect(frames).toEqual([{ kind: 'complete', sessionId: 'a' }]);
    });
});
