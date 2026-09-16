import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
    sanitizeSessionIdForTranscript,
    sanitizeSessionIdForCaseDir,
} from './pilotPaths.js';
import { resolveMemoryScopeIdentity, isWarTraumaScope } from './memoryIdentity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
    readFileSync(join(__dirname, '../../../tests/fixtures/memory-identity.golden.json'), 'utf8'),
);

// ── slug cases ─────────────────────────────────────────────────────────────

describe('sanitizeSessionIdForTranscript (JS)', () => {
    it.each(golden.sessionSlugCases)(
        'transcriptSlug: $note',
        ({ sessionId, transcriptSlug, note }) => {
            expect(sanitizeSessionIdForTranscript(sessionId)).toBe(transcriptSlug);
        },
    );
});

describe('sanitizeSessionIdForCaseDir (JS)', () => {
    it.each(golden.sessionSlugCases)(
        'caseDirSlug: $note',
        ({ sessionId, caseDirSlug }) => {
            expect(sanitizeSessionIdForCaseDir(sessionId)).toBe(caseDirSlug);
        },
    );
});

// ── identity cases ─────────────────────────────────────────────────────────

describe('resolveMemoryScopeIdentity (JS)', () => {
    it.each(golden.identityCases)('$note', ({ input, expected }) => {
        const result = resolveMemoryScopeIdentity(input);
        for (const [key, value] of Object.entries(expected)) {
            expect(result[key]).toBe(value);
        }
        // Fields absent from expected must not appear on result.
        for (const key of ['projectPath', 'sessionId', 'transcriptSlug', 'caseDirSlug', 'displayName']) {
            if (!(key in expected)) {
                expect(result[key]).toBeUndefined();
            }
        }
    });
});

describe('isWarTraumaScope (JS)', () => {
    it('returns true for trauma_med projects', () => {
        const id = resolveMemoryScopeIdentity({ projectKey: 'trauma_med-demo', pilotHome: '/tmp/ph' });
        expect(isWarTraumaScope(id)).toBe(true);
    });

    it('returns false for general_med projects', () => {
        const id = resolveMemoryScopeIdentity({ projectKey: 'general_med-clinic1', pilotHome: '/tmp/ph' });
        expect(isWarTraumaScope(id)).toBe(false);
    });
});

describe('slug pair invariant (JS)', () => {
    it('produces both slugs together when sessionId is given', () => {
        const id = resolveMemoryScopeIdentity({
            projectKey: 'trauma_med-demo',
            pilotHome: '/tmp/ph',
            sessionId: 'web:s_3f2a1b',
        });
        expect(id.transcriptSlug).toBe('web:s_3f2a1b');
        expect(id.caseDirSlug).toBe('web_s_3f2a1b');
    });

    it('produces neither slug when sessionId is absent', () => {
        const id = resolveMemoryScopeIdentity({ projectKey: 'trauma_med-demo', pilotHome: '/tmp/ph' });
        expect(id.transcriptSlug).toBeUndefined();
        expect(id.caseDirSlug).toBeUndefined();
    });

    it('treats empty string sessionId as absent', () => {
        const id = resolveMemoryScopeIdentity({
            projectKey: 'trauma_med-demo',
            pilotHome: '/tmp/ph',
            sessionId: '',
        });
        expect(id.transcriptSlug).toBeUndefined();
        expect(id.caseDirSlug).toBeUndefined();
    });
});
