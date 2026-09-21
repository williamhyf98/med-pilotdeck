import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createTrustedGatewayTurnOptions,
    gatewayEventToFrames,
    getGatewayTurnSafetyOverrides,
    isGatewayUnavailableError,
    sanitizeTraumaAttachments,
    sanitizeTraumaFormInput,
} from './pilotdeck-bridge.js';

describe('sanitizeTraumaFormInput', () => {
    it('forwards the supported structural fields', () => {
        expect(sanitizeTraumaFormInput({
            statedSubStage: 'primary_first_aid',
            injuryNarrative: '右小腿伤',
            treatmentNarrative: '',
            evacuationNarrative: '',
            note: '',
            vitals: { respiratoryRate: 30 },
        })).toEqual({
            statedSubStage: 'primary_first_aid',
            injuryNarrative: '右小腿伤',
            treatmentNarrative: '',
            evacuationNarrative: '',
            note: '',
            vitals: { respiratoryRate: 30 },
        });
    });

    it('rejects unknown vital keys and invalid substages', () => {
        const base = {
            statedSubStage: null,
            injuryNarrative: '伤情',
            treatmentNarrative: '',
            evacuationNarrative: '',
            note: '',
            vitals: {},
        };
        expect(() => sanitizeTraumaFormInput({
            ...base,
            vitals: { spo2: 95 },
        })).toThrow(/vital/i);
        expect(() => sanitizeTraumaFormInput({
            ...base,
            statedSubStage: 'field_specialist_treatment',
        })).toThrow(/substage/i);
        expect(() => sanitizeTraumaFormInput({
            ...base,
            extra: true,
        })).toThrow(/field/i);
    });

    it('enforces backend narrative, non-empty, and vital constraints', () => {
        const base = {
            statedSubStage: null,
            injuryNarrative: '伤情',
            treatmentNarrative: '',
            evacuationNarrative: '',
            note: '',
            vitals: {},
        };
        expect(() => sanitizeTraumaFormInput({
            ...base,
            injuryNarrative: '伤'.repeat(1001),
        })).toThrow(/narrative/i);
        expect(() => sanitizeTraumaFormInput({
            ...base,
            injuryNarrative: '   ',
        })).toThrow(/empty/i);
        expect(() => sanitizeTraumaFormInput({
            ...base,
            injuryNarrative: '',
            statedSubStage: 'primary_first_aid',
        })).toThrow(/empty/i);
        expect(() => sanitizeTraumaFormInput({
            ...base,
            vitals: { gcs: 16 },
        })).toThrow(/vital/i);
        expect(() => sanitizeTraumaFormInput({
            ...base,
            vitals: { respiratoryRate: 20.5 },
        })).toThrow(/integer/i);
        expect(() => sanitizeTraumaFormInput({
            ...base,
            vitals: { temperature: 36.66 },
        })).toThrow(/precision/i);
        expect(sanitizeTraumaFormInput({
            ...base,
            injuryNarrative: '',
            vitals: { temperature: 36.6 },
        }).vitals.temperature).toBe(36.6);
    });
});

describe('getGatewayTurnSafetyOverrides', () => {
    it('converts the one-way disable flag into a no-tools Gateway turn', () => {
        expect(getGatewayTurnSafetyOverrides({ disableTools: true })).toEqual({
            canPrompt: false,
            turnOverrides: { allowedTools: [] },
        });
    });

    it('does not forward caller-provided tool policy objects', () => {
        expect(getGatewayTurnSafetyOverrides({
            turnOverrides: { allowedTools: ['read_file'] },
        })).toEqual({});
    });

    it('forwards bounded model controls but strips caller tool policy and metadata', () => {
        expect(getGatewayTurnSafetyOverrides({
            turnOverrides: {
                temperature: 0.2,
                topP: 0.9,
                maxOutputTokens: 2048,
                allowedTools: ['bash'],
                metadata: { hidden: true },
            },
        })).toEqual({
            turnOverrides: {
                temperature: 0.2,
                topP: 0.9,
                maxOutputTokens: 2048,
            },
        });
    });

    it('forwards registered model and thinking controls without exposing endpoints', () => {
        expect(getGatewayTurnSafetyOverrides({
            model: 'openai/medical-model',
            profile: 'medical:general',
            thinking: { enabled: true, mode: 'medium' },
            syntheticMessages: [{
                text: 'trusted UI task context',
                purpose: 'medical_task_context',
            }],
        })).toEqual({
            profile: 'medical:general',
            syntheticMessages: [{
                text: 'trusted UI task context',
                purpose: 'medical_task_context',
            }],
            turnOverrides: {
                provider: 'openai',
                model: 'medical-model',
                thinking: { enabled: true, mode: 'medium' },
            },
        });
    });

    it('accepts profile and narrowed tool policy only from server-owned options', () => {
        const trusted = createTrustedGatewayTurnOptions({
            profile: 'medical:trauma',
            turnOverrides: {
                allowedTools: ['mcp__medical__rag'],
                metadata: { task: 'trauma-analysis' },
            },
            maxTurns: 1,
        });
        expect(getGatewayTurnSafetyOverrides(trusted)).toEqual({
            profile: 'medical:trauma',
            maxTurns: 1,
            turnOverrides: {
                allowedTools: ['mcp__medical__rag'],
                metadata: { task: 'trauma-analysis' },
            },
        });
    });
});

describe('gatewayEventToFrames agent status errors', () => {
    it('preserves assistant text citation metadata on stream deltas', () => {
        const citations = [{
            index: 1,
            title: '战伤救治规则',
            section: '第二章 分类救治',
        }];
        const frames = gatewayEventToFrames({
            type: 'assistant_text_delta',
            text: '应先控制活动性出血[1]。',
            citations,
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'stream_delta',
            content: '应先控制活动性出血[1]。',
            citations,
        });
    });

    it('carries the used citation subset on stream end so 参考来源 can render immediately', () => {
        const citations = [{
            index: 1,
            title: '战伤救治规则',
            section: '第二章 分类救治',
        }];
        const frames = gatewayEventToFrames({
            type: 'assistant_text_end',
            citations,
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({ kind: 'stream_end', citations });
    });

    it('omits citations on stream end when nothing was cited', () => {
        const frames = gatewayEventToFrames({
            type: 'assistant_text_end',
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0].citations).toBeUndefined();
    });

    it('maps medical tool activity to an upsertable agent activity without raw data', () => {
        const frames = gatewayEventToFrames({
            type: 'tool_activity',
            activityId: 'medical:call-radar',
            toolCallId: 'call-radar',
            toolName: 'mcp__med-tools__med_radar_analyze_ct',
            title: '正在执行 RADAR 推理',
            detail: '远程模型正在分析三维 CT',
            state: 'running',
            phase: 'medical',
            createdAt: '2026-09-21T08:00:00.000Z',
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            id: 'tool_activity_web:s_test_medical:call-radar',
            kind: 'agent_activity',
            activityId: 'medical:call-radar',
            phase: 'medical',
            state: 'running',
            title: '正在执行 RADAR 推理',
            detail: '远程模型正在分析三维 CT',
        });
        expect(JSON.stringify(frames[0])).not.toContain('/private/');
    });

    it('maps tool result detail availability to a mergeable tool_result frame', () => {
        const frames = gatewayEventToFrames({
            type: 'tool_result_detail_available',
            toolCallId: 'call-large',
            resultPath: '/tmp/pilotdeck/tool-result.txt',
            fullText: 'x'.repeat(100000),
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'tool_result',
            toolId: 'call-large',
            content: 'Full tool result persisted at /tmp/pilotdeck/tool-result.txt',
            resultPath: '/tmp/pilotdeck/tool-result.txt',
        });
        expect(frames[0].fullText).toBeUndefined();
    });

    it('bounds live tool result previews before they reach React state', () => {
        const frames = gatewayEventToFrames({
            type: 'tool_call_finished',
            toolCallId: 'call-large',
            ok: true,
            resultPreview: `head\n${'x'.repeat(50000)}\ntail`,
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0].kind).toBe('tool_result');
        expect(frames[0].content.length).toBeLessThan(22000);
        expect(frames[0].content).toContain('UI preview truncated');
        expect(frames[0].content).toContain('head');
        expect(frames[0].content).toContain('tail');
    });

    it('keeps RAG retrieval results intact so citation chunks survive to the popover', () => {
        const chunkTail = JSON.stringify({ citation_index: 8, text: '止血带原文'.repeat(10) });
        const ragPayload = `{"status":"ok","chunks":[${'x'.repeat(50000)},${chunkTail}]}`;
        const frames = gatewayEventToFrames({
            type: 'tool_call_finished',
            toolCallId: 'call-rag',
            toolName: 'med_trauma_rag_query',
            ok: true,
            resultPreview: ragPayload,
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0].kind).toBe('tool_result');
        expect(frames[0].content).toBe(ragPayload);
        expect(frames[0].content).not.toContain('UI preview truncated');
    });

    it('uses detail.userHint for model_empty_response_exhausted', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'model_empty_response_exhausted',
            detail: {
                message: 'The model returned empty content repeatedly.',
                userHint: 'Increase max output tokens.',
                visible: true,
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'The model returned empty content repeatedly.',
            code: 'model_empty_response_exhausted',
            userHint: 'Increase max output tokens.',
        });
    });

    it('renders new semantic status events as error frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'model_request_failed',
            detail: {
                message: 'Provider rejected the request.',
                messageI18n: { key: 'chat:agentStatus.modelRequestFailed.message', params: { providerMessage: 'Provider rejected the request.' } },
                userHint: 'Check provider settings.',
                userHintI18n: { key: 'chat:agentStatus.modelRequestFailed.actions.settingsDefault' },
                visible: true,
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'Provider rejected the request.',
            contentI18n: { key: 'chat:agentStatus.modelRequestFailed.message', params: { providerMessage: 'Provider rejected the request.' } },
            code: 'model_request_failed',
            userHint: 'Check provider settings.',
            userHintI18n: { key: 'chat:agentStatus.modelRequestFailed.actions.settingsDefault' },
        });
    });

    it('renders bridge visible failure status events as error frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'gateway_bridge_error',
            detail: {
                message: 'Bridge crashed while streaming.',
                code: 'gateway_bridge_error',
                severity: 'error',
                visible: true,
                userHint: 'Check UI server logs.',
                scope: 'turn',
                source: 'web_bridge',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'Bridge crashed while streaming.',
            code: 'gateway_bridge_error',
            userHint: 'Check UI server logs.',
        });
    });

    it('carries post-compact token budget on compact boundary frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'compact_completed',
            detail: {
                preTokens: 76000,
                postTokens: 12000,
                messagesSummarized: 8,
                tokenBudget: {
                    used: 12000,
                    displayUsed: 12000,
                    budgetUsed: 12000,
                    total: 100000,
                    effectiveTotal: 90000,
                    state: 'ok',
                    source: 'compact',
                },
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'compact_boundary',
            postTokens: 12000,
            tokenBudget: {
                used: 12000,
                total: 100000,
                state: 'ok',
                source: 'compact',
            },
        });
    });

    it('renders gateway unavailable preflight status as an error frame', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'gateway_unavailable',
            detail: {
                message: 'PilotDeck gateway is unavailable.',
                code: 'gateway_unavailable',
                severity: 'error',
                visible: true,
                userHint: 'Start or restart the PilotDeck gateway, then retry this message.',
                scope: 'preflight',
                source: 'web_bridge',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'PilotDeck gateway is unavailable.',
            code: 'gateway_unavailable',
            userHint: 'Start or restart the PilotDeck gateway, then retry this message.',
        });
    });
});

describe('sanitizeTraumaAttachments', () => {
    let projectRoot;
    let inboxDir;

    beforeEach(() => {
        projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-trauma-attach-'));
        inboxDir = path.join(projectRoot, 'inbox');
        fs.mkdirSync(inboxDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('accepts an absolute path that resolves inside <projectRoot>/inbox', () => {
        const filePath = path.join(inboxDir, 'ct-scan.dcm');
        fs.writeFileSync(filePath, 'stub');

        expect(sanitizeTraumaAttachments(
            [{ path: filePath, name: 'ct-scan.dcm' }],
            projectRoot,
        )).toEqual([{ path: fs.realpathSync(filePath), name: 'ct-scan.dcm' }]);
    });

    it('accepts a file directly inside the inbox root itself', () => {
        const filePath = path.join(inboxDir, 'report.pdf');
        fs.writeFileSync(filePath, 'stub');

        expect(sanitizeTraumaAttachments(
            [{ path: filePath, name: 'report.pdf' }],
            projectRoot,
        )).toEqual([{ path: fs.realpathSync(filePath), name: 'report.pdf' }]);
    });

    it('rejects a lexical "../" traversal out of the inbox', () => {
        const outside = path.join(projectRoot, 'secret.txt');
        fs.writeFileSync(outside, 'top secret');
        const traversal = path.join(inboxDir, '..', 'secret.txt');

        expect(sanitizeTraumaAttachments(
            [{ path: traversal, name: 'secret.txt' }],
            projectRoot,
        )).toBeUndefined();
    });

    it('rejects a symlink inside the inbox that points outside it', () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-trauma-outside-'));
        const outsideFile = path.join(outsideDir, 'private.dcm');
        fs.writeFileSync(outsideFile, 'private data');
        const linkPath = path.join(inboxDir, 'looks-safe.dcm');
        fs.symlinkSync(outsideFile, linkPath);

        try {
            // A naive `startsWith` check on the raw string would pass here
            // (the lexical path IS under the inbox); realpath resolution
            // must see through the symlink and reject it.
            expect(sanitizeTraumaAttachments(
                [{ path: linkPath, name: 'looks-safe.dcm' }],
                projectRoot,
            )).toBeUndefined();
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    });

    it('rejects a path outside the inbox that merely shares its string prefix', () => {
        // e.g. inbox is ".../inbox" and the attacker path is ".../inbox-evil/x"
        // — a naive `startsWith(inboxRoot)` check (without the trailing
        // separator) would wrongly accept this.
        const siblingDir = `${inboxDir}-evil`;
        fs.mkdirSync(siblingDir, { recursive: true });
        const filePath = path.join(siblingDir, 'x.txt');
        fs.writeFileSync(filePath, 'x');

        expect(sanitizeTraumaAttachments(
            [{ path: filePath, name: 'x.txt' }],
            projectRoot,
        )).toBeUndefined();
    });

    it('rejects a relative path even if it lexically resolves under the inbox', () => {
        const filePath = path.join(inboxDir, 'relative.dcm');
        fs.writeFileSync(filePath, 'stub');
        const relative = path.relative(process.cwd(), filePath);

        expect(sanitizeTraumaAttachments(
            [{ path: relative, name: 'relative.dcm' }],
            projectRoot,
        )).toBeUndefined();
    });

    it('rejects an entry with an empty name', () => {
        const filePath = path.join(inboxDir, 'no-name.dcm');
        fs.writeFileSync(filePath, 'stub');

        expect(sanitizeTraumaAttachments(
            [{ path: filePath, name: '' }, { path: filePath, name: '   ' }],
            projectRoot,
        )).toBeUndefined();
    });

    it('drops malformed entries but keeps valid ones in the same batch', () => {
        const good = path.join(inboxDir, 'good.dcm');
        fs.writeFileSync(good, 'stub');

        expect(sanitizeTraumaAttachments(
            [
                null,
                42,
                { path: 123, name: 'bad-path-type.dcm' },
                { path: good, name: '' },
                { path: good, name: 'good.dcm' },
            ],
            projectRoot,
        )).toEqual([{ path: fs.realpathSync(good), name: 'good.dcm' }]);
    });

    it('returns undefined for non-array input or a missing projectRoot', () => {
        expect(sanitizeTraumaAttachments(undefined, projectRoot)).toBeUndefined();
        expect(sanitizeTraumaAttachments(null, projectRoot)).toBeUndefined();
        expect(sanitizeTraumaAttachments('not-an-array', projectRoot)).toBeUndefined();
        const filePath = path.join(inboxDir, 'a.dcm');
        fs.writeFileSync(filePath, 'stub');
        expect(sanitizeTraumaAttachments([{ path: filePath, name: 'a.dcm' }], undefined)).toBeUndefined();
    });

    it('returns undefined for an empty array', () => {
        expect(sanitizeTraumaAttachments([], projectRoot)).toBeUndefined();
    });

    it('caps the number of accepted attachments at the shared upload limit (64)', () => {
        const entries = [];
        for (let i = 0; i < 70; i += 1) {
            const filePath = path.join(inboxDir, `file-${i}.dcm`);
            fs.writeFileSync(filePath, 'stub');
            entries.push({ path: filePath, name: `file-${i}.dcm` });
        }

        const result = sanitizeTraumaAttachments(entries, projectRoot);
        expect(result).toHaveLength(64);
    });

    it('dedupes repeated entries by resolved path instead of counting each toward the cap', () => {
        const filePath = path.join(inboxDir, 'dupe.dcm');
        fs.writeFileSync(filePath, 'stub');
        const entries = Array.from({ length: 1000 }, () => ({ path: filePath, name: 'dupe.dcm' }));

        const result = sanitizeTraumaAttachments(entries, projectRoot);
        expect(result).toEqual([{ path: fs.realpathSync(filePath), name: 'dupe.dcm' }]);
    });

    it('strips path separators and control characters from name and caps it at 200 chars', () => {
        const filePath = path.join(inboxDir, 'weird-name.dcm');
        fs.writeFileSync(filePath, 'stub');
        const longName = `../../etc/passwd ${'x'.repeat(400)}`;

        const result = sanitizeTraumaAttachments(
            [{ path: filePath, name: longName }],
            projectRoot,
        );

        expect(result).toHaveLength(1);
        const sanitizedName = result[0].name;
        expect(sanitizedName.length).toBeLessThanOrEqual(200);
        expect(sanitizedName).not.toMatch(/[/\\]/);
        // eslint-disable-next-line no-control-regex
        expect(sanitizedName).not.toMatch(/[\x00-\x1f]/);
    });

    it('drops an entry whose name is nothing but path separators/control characters', () => {
        const filePath = path.join(inboxDir, 'empty-after-strip.dcm');
        fs.writeFileSync(filePath, 'stub');

        expect(sanitizeTraumaAttachments(
            [{ path: filePath, name: '//// ' }],
            projectRoot,
        )).toBeUndefined();
    });

    it('rejects a non-existent inbox path instead of falling back to a lexical resolve', () => {
        const missing = path.join(inboxDir, 'does-not-exist.dcm');

        expect(sanitizeTraumaAttachments(
            [{ path: missing, name: 'does-not-exist.dcm' }],
            projectRoot,
        )).toBeUndefined();
    });

    it('rejects a directory path (the inbox root itself)', () => {
        expect(sanitizeTraumaAttachments(
            [{ path: inboxDir, name: 'inbox' }],
            projectRoot,
        )).toBeUndefined();
    });

    it('rejects a subdirectory under the inbox', () => {
        const subDir = path.join(inboxDir, 'subdir');
        fs.mkdirSync(subDir, { recursive: true });

        expect(sanitizeTraumaAttachments(
            [{ path: subDir, name: 'subdir' }],
            projectRoot,
        )).toBeUndefined();
    });
});

describe('isGatewayUnavailableError', () => {
    it('detects cached gateway websocket disconnects', () => {
        expect(isGatewayUnavailableError(new Error('Gateway WebSocket is not connected.'))).toBe(true);
        expect(isGatewayUnavailableError(new Error('Gateway WebSocket closed.'))).toBe(true);
        expect(isGatewayUnavailableError(new Error('Gateway closed during hello: auth_failed'))).toBe(true);
        expect(isGatewayUnavailableError(new Error('[pilotdeck-bridge] gateway connect failed after 60000ms'))).toBe(true);
    });

    it('does not classify generic bridge failures as gateway unavailable', () => {
        expect(isGatewayUnavailableError(new Error('Unexpected frame payload'))).toBe(false);
    });
});
