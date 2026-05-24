import * as vscode from 'vscode';
import { getCustomMcpServers, getRuntimeMcpServers } from '../../../src/runtime/mcpRegistry';
import { getProviderConfig } from '../../../src/runtime/providerRegistry';
import { ConfigManager } from '../../../src/utils/configManager';

jest.mock('vscode');

describe('mcpRegistry', () => {
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

    test('returns built-in MCP servers for runtime providers', () => {
        const provider = getProviderConfig('codex');
        const servers = getRuntimeMcpServers(provider);

        expect(servers.map(server => server.name)).toEqual(expect.arrayContaining([
            'context7',
            'puppeteer',
            'electron'
        ]));
        expect(servers.every(server => server.status === 'available')).toBe(true);
    });

    test('parses custom stdio MCP servers from settings', () => {
        configValues['mcp.customServers'] = [
            {
                id: 'docs',
                type: 'stdio',
                command: 'npx',
                args: ['-y', 'docs-mcp'],
                description: 'Docs lookup'
            }
        ];

        const servers = getCustomMcpServers();

        expect(servers).toHaveLength(1);
        expect(servers[0]).toMatchObject({
            name: 'docs',
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'docs-mcp'],
            providerSource: 'Custom'
        });
    });

    test('parses custom HTTP MCP servers from settings', () => {
        configValues['mcp.customServers'] = [
            {
                id: 'remote-memory',
                type: 'http',
                url: 'http://localhost:8765/mcp'
            }
        ];

        const servers = getCustomMcpServers();

        expect(servers[0]).toMatchObject({
            name: 'remote-memory',
            type: 'http',
            url: 'http://localhost:8765/mcp'
        });
    });

    test('reads custom MCP servers from project settings when VS Code setting is absent', () => {
        const configManager = ConfigManager.getInstance();
        (configManager as any).settings = {
            agent: { provider: 'codex' },
            providers: {},
            mcp: {
                customServers: [
                    {
                        id: 'project-docs',
                        type: 'stdio',
                        command: 'node',
                        args: ['server.js']
                    }
                ]
            },
            paths: { specs: '.claude/specs', steering: '.claude/steering', settings: '.claude/settings' },
            views: {
                specs: { visible: true },
                agents: { visible: true },
                steering: { visible: true },
                mcp: { visible: true },
                hooks: { visible: true },
                settings: { visible: false }
            }
        };

        const servers = getCustomMcpServers();

        expect(servers).toHaveLength(1);
        expect(servers[0]).toMatchObject({
            name: 'project-docs',
            command: 'node',
            args: ['server.js']
        });
    });
});
