import * as vscode from 'vscode';
import { ConfigManager } from '../../../src/utils/configManager';

jest.mock('vscode');

describe('ConfigManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (ConfigManager as any).instance = undefined;
        (vscode.Uri as any).file = jest.fn((filePath: string) => ({
            fsPath: filePath,
            path: filePath,
            scheme: 'file'
        }));
        (vscode.workspace as any).workspaceFolders = [{
            uri: vscode.Uri.file('/mock/workspace'),
            name: 'mock-workspace',
            index: 0
        }];
    });

    test('uses .autocode/settings/autocode-settings.json as the settings file', () => {
        const configManager = ConfigManager.getInstance();

        expect(configManager.getSettingsFilePath().replace(/\\/g, '/')).toBe('/mock/workspace/.autocode/settings/autocode-settings.json');
    });

    test('migrates legacy .claude default paths when reading old settings', async () => {
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation((uri: vscode.Uri) => {
            const path = uri.fsPath.replace(/\\/g, '/');
            if (path.endsWith('/.autocode/settings/autocode-settings.json')) {
                return Promise.reject(new Error('missing new settings'));
            }

            if (path.endsWith('/.claude/settings/kfc-settings.json')) {
                return Promise.resolve(Buffer.from(JSON.stringify({
                    agent: { provider: 'codex' },
                    providers: { codex: { command: 'codex' } },
                    mcp: { customServers: [] },
                    paths: {
                        specs: '.claude/specs',
                        steering: '.claude/steering',
                        settings: '.claude/settings'
                    }
                })));
            }

            return Promise.reject(new Error(`unexpected path: ${path}`));
        });

        const settings = await ConfigManager.getInstance().loadSettings();

        expect(settings.agent.provider).toBe('codex');
        expect(settings.paths).toEqual({
            specs: '.autocode/specs',
            steering: '.autocode/steering',
            settings: '.autocode/settings'
        });
    });
});
