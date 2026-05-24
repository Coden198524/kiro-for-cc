import * as vscode from 'vscode';
import { getProviderConfig, getProviderDisplayName, isAgentProviderId } from '../../../src/runtime/providerRegistry';
import { ConfigManager } from '../../../src/utils/configManager';

jest.mock('vscode');

describe('providerRegistry', () => {
    let configValues: Record<string, unknown>;

    beforeEach(() => {
        configValues = {};
        (ConfigManager as any).instance = undefined;
        (vscode.workspace as any).getConfiguration = jest.fn(() => ({
            inspect: jest.fn((key: string) => (
                Object.prototype.hasOwnProperty.call(configValues, key)
                    ? { workspaceValue: configValues[key] }
                    : undefined
            )),
            get: jest.fn((key: string, defaultValue?: unknown) => (
                Object.prototype.hasOwnProperty.call(configValues, key)
                    ? configValues[key]
                    : defaultValue
            ))
        }));
    });

    test('detects supported provider ids', () => {
        expect(isAgentProviderId('claude')).toBe(true);
        expect(isAgentProviderId('codex')).toBe(true);
        expect(isAgentProviderId('deepseek')).toBe(true);
        expect(isAgentProviderId('glm')).toBe(true);
        expect(isAgentProviderId('unknown')).toBe(false);
    });

    test('returns Claude provider by default', () => {
        const provider = getProviderConfig();

        expect(provider.id).toBe('claude');
        expect(provider.displayName).toBe('Claude Code');
        expect(provider.command).toBe('claude');
        expect(provider.capabilities.permissions).toBe(true);
        expect(provider.capabilities.expertAgents).toBe(true);
        expect(provider.capabilities.claudeAgents).toBe(true);
        expect(provider.capabilities.claudeMcp).toBe(true);
    });

    test('uses configured Codex command and args', () => {
        configValues['agent.provider'] = 'codex';
        configValues['providers.codex.command'] = 'codex-cli';
        configValues['providers.codex.args'] = ['--model', 'gpt-5.5'];

        const provider = getProviderConfig();

        expect(provider.id).toBe('codex');
        expect(provider.command).toBe('codex-cli');
        expect(provider.args).toEqual(['--model', 'gpt-5.5']);
        expect(provider.capabilities.permissions).toBe(false);
        expect(provider.capabilities.expertAgents).toBe(true);
        expect(provider.capabilities.claudeAgents).toBe(false);
        expect(provider.capabilities.extensionMcp).toBe(true);
    });

    test('keeps generic CLI providers without expert agents', () => {
        const provider = getProviderConfig('deepseek');

        expect(provider.capabilities.expertAgents).toBe(false);
        expect(provider.capabilities.claudeAgents).toBe(false);
    });

    test('reads provider settings from project settings when VS Code setting is absent', () => {
        const configManager = ConfigManager.getInstance();
        (configManager as any).settings = {
            agent: { provider: 'deepseek' },
            providers: {
                deepseek: {
                    command: 'deepseek-chat',
                    args: ['--model', 'deepseek-reasoner']
                }
            },
            mcp: { customServers: [] },
            paths: { specs: '.autocode/specs', steering: '.autocode/steering', settings: '.autocode/settings' },
            views: {
                specs: { visible: true },
                agents: { visible: true },
                steering: { visible: true },
                mcp: { visible: true },
                hooks: { visible: true },
                settings: { visible: false }
            }
        };

        const provider = getProviderConfig();

        expect(provider.id).toBe('deepseek');
        expect(provider.command).toBe('deepseek-chat');
        expect(provider.args).toEqual(['--model', 'deepseek-reasoner']);
    });

    test('returns custom display name', () => {
        configValues['providers.custom.displayName'] = 'Local Agent';

        expect(getProviderDisplayName('custom')).toBe('Local Agent');
    });

    test('includes optional active model in provider config', () => {
        configValues['agent.model'] = 'gpt-5.5';

        const provider = getProviderConfig('codex');

        expect(provider.model).toBe('gpt-5.5');
    });
});
