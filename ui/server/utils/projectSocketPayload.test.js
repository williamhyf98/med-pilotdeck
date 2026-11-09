import { describe, expect, it } from 'vitest';
import { toSocketProjects } from './projectSocketPayload.js';

describe('toSocketProjects', () => {
    it('replaces filesystem paths with the stable project id', () => {
        const projects = [{
            name: 'general_med-case-1',
            fullPath: '/srv/pilot/users/7/workspaces/general_med/general_med-case-1',
            path: '/srv/pilot/users/7/workspaces/general_med/general_med-case-1',
            sessions: [{ cwd: 'general_med-case-1' }],
        }];

        const result = toSocketProjects(projects, { userId: 7, pilotRoot: '/srv/pilot' });

        expect(result[0]).toMatchObject({
            name: 'general_med-case-1',
            fullPath: 'general_med-case-1',
            path: 'general_med-case-1',
        });
        expect(JSON.stringify(result)).not.toContain('/srv/pilot/users/7');
    });

    it('sanitizes nested path metadata before the stable path override', () => {
        const projects = [{
            name: 'case-2',
            fullPath: '/srv/pilot/users/8/workspaces/general_med/case-2',
            path: '/srv/pilot/users/8/workspaces/general_med/case-2',
            taskmaster: { workspace: '/srv/pilot/users/8/private-notes' },
        }];

        const result = toSocketProjects(projects, { userId: 8, pilotRoot: '/srv/pilot' });

        expect(JSON.stringify(result)).not.toContain('/srv/pilot/users/8');
        expect(result[0].fullPath).toBe('case-2');
        expect(result[0].path).toBe('case-2');
    });
});
