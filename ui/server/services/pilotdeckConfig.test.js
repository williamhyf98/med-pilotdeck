import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildDefaultPilotDeckConfig,
    buildRuntimeEnv,
    normalizePilotDeckConfig,
    readMultiUserConfig,
    readPilotDeckConfigFile,
    sanitizeProviderCredentials,
    validatePilotDeckConfig,
} from './pilotdeckConfig.js';

const tempDirs = [];

it('anchors relative runtime paths to pilot home', () => {
    const env = buildRuntimeEnv({ webui: { runtime: { databasePath: 'system/auth.db', workspacesRoot: 'workspaces' } } });
    const home = process.env.PILOT_HOME || join(homedir(), '.pilotdeck');
    expect(env.DATABASE_PATH).toBe(join(home, 'system', 'auth.db'));
    expect(env.WORKSPACES_ROOT).toBe(join(home, 'workspaces'));
});

it('ignores a pre-multi-user databasePath that points at the legacy <root>/auth.db', () => {
    // Plan 1 leaves the legacy single-user database alone; db.js then applies
    // its own default instead of opening and migrating it in place.
    const home = process.env.PILOT_HOME || join(homedir(), '.pilotdeck');
    expect(buildRuntimeEnv({ webui: { runtime: { databasePath: 'auth.db' } } }).DATABASE_PATH).toBeUndefined();
    expect(buildRuntimeEnv({ webui: { runtime: { databasePath: './auth.db' } } }).DATABASE_PATH).toBeUndefined();
    expect(buildRuntimeEnv({ webui: { runtime: { databasePath: join(home, 'auth.db') } } }).DATABASE_PATH).toBeUndefined();
    // An explicit path elsewhere is still an operator choice and is honoured.
    expect(buildRuntimeEnv({ webui: { runtime: { databasePath: '/var/db/pd.db' } } }).DATABASE_PATH).toBe('/var/db/pd.db');
});

it('defaults databasePath to the system directory', () => {
    expect(normalizePilotDeckConfig({}).webui.runtime.databasePath).toBe('system/auth.db');
});

it('uses flat UI fields first and falls back to each legacy schedule field', () => {
    expect(normalizePilotDeckConfig({ memory: {
        maintenanceMode: 'immediate', autoIndexIntervalMinutes: 0,
        schedule: { maintenanceMode: 'manual', autoIndexIntervalMinutes: 90, autoDreamIntervalMinutes: 120 },
    } }).memory).toMatchObject({ maintenanceMode: 'immediate', autoIndexIntervalMinutes: 0, autoDreamIntervalMinutes: 120 });
    expect(normalizePilotDeckConfig({ memory: { schedule: { autoDreamIntervalMinutes: 120 } } }).memory)
        .toMatchObject({ maintenanceMode: 'interval', autoDreamIntervalMinutes: 120 });
});

it('preserves legacy intervals while defaulting new memory configuration to immediate', () => {
    expect(buildDefaultPilotDeckConfig().memory.maintenanceMode).toBe('immediate');
    expect(normalizePilotDeckConfig({ memory: { autoIndexIntervalMinutes: 0 } }).memory.maintenanceMode).toBe('interval');
    expect(normalizePilotDeckConfig({ memory: { maintenanceMode: 'manual' } }).memory.maintenanceMode).toBe('manual');
});

afterEach(() => {
    delete process.env.PILOTDECK_CONFIG_PATH;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function useTempConfig(contents, filename = 'pilotdeck.yaml') {
    const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-config-test-'));
    tempDirs.push(dir);
    const configPath = join(dir, filename);
    if (contents !== null) {
        writeFileSync(configPath, contents, 'utf8');
    }
    process.env.PILOTDECK_CONFIG_PATH = configPath;
    return configPath;
}

describe('readPilotDeckConfigFile fallback behavior', () => {
    it('uses built-in Office preview by default', () => {
        expect(buildDefaultPilotDeckConfig().webui.officePreview).toEqual({
            service: 'builtin',
            binaryPath: '',
        });
    });

    it('returns defaults when the config file is missing', () => {
        const configPath = useTempConfig(null);

        const record = readPilotDeckConfigFile();

        expect(record.exists).toBe(false);
        expect(record.configPath).toBe(configPath);
        expect(record.raw).toBe('');
        expect(record.rawYaml).toEqual({});
        expect(record.parseError).toBeNull();
        expect(record.config.schemaVersion).toBe(1);
        expect(record.config.webui.officePreview.service).toBe('builtin');
    });

    it('reads and normalizes valid YAML', () => {
        useTempConfig('schemaVersion: 1\nmodel:\n  providers: {}\n');

        const record = readPilotDeckConfigFile();

        expect(record.exists).toBe(true);
        expect(record.parseError).toBeNull();
        expect(record.rawYaml).toMatchObject({ schemaVersion: 1, model: { providers: {} } });
        expect(record.config.model.providers).toEqual({});
        expect(record.config.memory.enabled).toBe(true);
    });

    it('keeps raw YAML and falls back to defaults when YAML is invalid', () => {
        const raw = 'schemaVersion: 1\nmodel:\n  providers: [\n';
        useTempConfig(raw);

        const record = readPilotDeckConfigFile();

        expect(record.exists).toBe(true);
        expect(record.raw).toBe(raw);
        expect(record.rawYaml).toBeNull();
        expect(record.parseError).toEqual(expect.any(String));
        expect(record.config.schemaVersion).toBe(1);
        expect(record.config.model.providers).toEqual({});
    });
});

describe('validatePilotDeckConfig gateway validation', () => {
    it('migrates the legacy interactive spreadsheet mode to built-in preview', () => {
        const validation = validatePilotDeckConfig({
            webui: {
                officePreview: {
                    service: 'libreoffice',
                    spreadsheetMode: 'auto',
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.config.webui.officePreview).toEqual({
            service: 'builtin',
            binaryPath: '',
        });
    });

    it('migrates the legacy print spreadsheet mode to LibreOffice preview', () => {
        const validation = validatePilotDeckConfig({
            webui: {
                officePreview: {
                    service: 'libreoffice',
                    spreadsheetMode: 'print',
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.config.webui.officePreview).toEqual({
            service: 'libreoffice',
            binaryPath: '',
        });
    });

    it('migrates the legacy disabled Office service to built-in preview', () => {
        const validation = validatePilotDeckConfig({
            webui: {
                officePreview: {
                    service: 'none',
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.config.webui.officePreview.service).toBe('builtin');
    });

    it('rejects unsupported Office preview services', () => {
        const validation = validatePilotDeckConfig({
            webui: {
                officePreview: {
                    service: 'unexpected',
                },
            },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain(
            'webui.officePreview.service must be "builtin" or "libreoffice"',
        );
    });

    it('rejects non-object gateway config', () => {
        const validation = validatePilotDeckConfig({ gateway: true });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain('gateway: gateway config must be an object.');
    });

    it('rejects unsupported gateway bindAddress', () => {
        const validation = validatePilotDeckConfig({
            gateway: {
                bindAddress: '0.0.0.0',
            },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain('gateway.bindAddress: gateway.bindAddress must be 127.0.0.1 in the first phase.');
    });

    it('warns when gateway.tokenPath is configured', () => {
        const validation = validatePilotDeckConfig({
            gateway: {
                tokenPath: '/tmp/token',
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.warnings).toContain(
            'gateway.tokenPath: gateway.tokenPath is no longer configurable; the gateway token is stored under PilotHome.',
        );
    });

    it('accepts valid gateway config', () => {
        const validation = validatePilotDeckConfig({
            gateway: {
                bindAddress: '127.0.0.1',
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.errors).toEqual([]);
    });

    it('accepts Ollama providers without an apiKey', () => {
        const validation = validatePilotDeckConfig({
            agent: { model: 'ollama/qwen3:0.6b' },
            model: {
                providers: {
                    ollama: {
                        protocol: 'openai',
                        url: 'http://localhost:11434/v1',
                        models: {
                            'qwen3:0.6b': {},
                        },
                    },
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.errors).toEqual([]);
    });

    it('removes blank Ollama apiKeys during sanitization', () => {
        const config = sanitizeProviderCredentials({
            model: {
                providers: {
                    ollama: {
                        protocol: 'openai',
                        url: ' http://localhost:11434/v1 ',
                        apiKey: '   ',
                        models: {
                            'qwen3:0.6b': {},
                        },
                    },
                },
            },
        });

        expect(config.model.providers.ollama).not.toHaveProperty('apiKey');
        expect(config.model.providers.ollama.url).toBe('http://localhost:11434/v1');
    });
});

describe('readMultiUserConfig', () => {
    afterEach(() => { delete process.env.PILOTDECK_GATEWAY_PORT_BASE; });

    it('returns pool defaults when the yaml has no multiUser block', () => {
        useTempConfig(null);
        expect(readMultiUserConfig().gatewayPool).toEqual({
            maxInstances: 30, idleTimeoutMs: 30 * 60_000, startTimeoutMs: 60_000, maxWaiting: 20, portBase: 18800,
        });
    });

    it('reads multiUser.gatewayPool overrides and lets the env port base win', () => {
        useTempConfig('multiUser:\n  gatewayPool:\n    maxInstances: 5\n    portBase: 19000\n');
        expect(readMultiUserConfig().gatewayPool).toMatchObject({ maxInstances: 5, portBase: 19000, maxWaiting: 20 });
        process.env.PILOTDECK_GATEWAY_PORT_BASE = '21000';
        expect(readMultiUserConfig().gatewayPool.portBase).toBe(21000);
    });
});

describe('maskRawYamlText', () => {
    it('masks secret-looking values in YAML that cannot be parsed', async () => {
        const { maskRawYamlText } = await import('./pilotdeckConfig.js');
        const broken = [
            'providers:',
            '  - apiKey: sk-leak',
            '    api_key: "sk-quoted-leak"',
            '    token: ghp_leak',
            '    appSecret: shh',
            '    password: hunter2',
            '    url: https://example.invalid/v1',
            '  bad: [',
            '',
        ].join('\n');
        const masked = maskRawYamlText(broken);
        expect(masked).not.toContain('sk-leak');
        expect(masked).not.toContain('sk-quoted-leak');
        expect(masked).not.toContain('ghp_leak');
        expect(masked).not.toContain('shh');
        expect(masked).not.toContain('hunter2');
        // Structure and non-secret values survive, so the editor still shows the
        // broken document the user has to repair.
        expect(masked).toContain('url: https://example.invalid/v1');
        expect(masked).toContain('  bad: [');
        expect(masked).toContain('  - apiKey: ********');
    });

    it('masks the parse error message, which quotes the offending source lines', async () => {
        const { readPilotDeckConfigFile } = await import('./pilotdeckConfig.js');
        const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-parse-'));
        tempDirs.push(dir);
        const previous = process.env.PILOT_HOME;
        process.env.PILOT_HOME = dir;
        try {
            writeFileSync(join(dir, 'pilotdeck.yaml'), 'providers:\n  - apiKey: sk-leak\n  bad: [\n');
            const record = readPilotDeckConfigFile();
            expect(record.parseError).toBeTruthy();
            expect(JSON.stringify(record.parseError)).not.toContain('sk-leak');
        } finally {
            if (previous === undefined) delete process.env.PILOT_HOME;
            else process.env.PILOT_HOME = previous;
        }
    });

    it('leaves empty values and non-strings alone', async () => {
        const { maskRawYamlText } = await import('./pilotdeckConfig.js');
        expect(maskRawYamlText('apiKey:\ntoken:\n')).toBe('apiKey:\ntoken:\n');
        expect(maskRawYamlText('')).toBe('');
        expect(maskRawYamlText(null)).toBe('');
    });
});
