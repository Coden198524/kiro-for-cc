import * as vscode from 'vscode';
import { OverviewProvider } from '../../../src/providers/overviewProvider';
import { ConfigManager } from '../../../src/utils/configManager';

jest.mock('vscode');

describe('OverviewProvider', () => {
    let configValues: Record<string, unknown>;

    beforeEach(() => {
        jest.clearAllMocks();
        configValues = {};
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
            )),
            update: jest.fn()
        }));
        (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error('missing settings'));
    });

    test('shows active provider, active model, provider list, and settings actions', async () => {
        configValues['agent.provider'] = 'codex';
        configValues['agent.model'] = 'gpt-5.5';
        const provider = new OverviewProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext);

        const rootItems = await provider.getChildren();

        expect(rootItems.map(item => item.label)).toEqual([
            'Provider: Codex',
            'Model: gpt-5.5',
            'Providers',
            'Open Settings'
        ]);
        expect(rootItems[0].command?.command).toBe('autocode.model.selectProvider');
        expect(rootItems[1].command?.command).toBe('autocode.model.setModel');
        expect(rootItems[3].command?.command).toBe('autocode.settings.open');
    });

    test('marks the active provider in the provider list', async () => {
        configValues['agent.provider'] = 'deepseek';
        const provider = new OverviewProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext);
        const rootItems = await provider.getChildren();
        const providersGroup = rootItems.find(item => item.label === 'Providers');

        const providerItems = await provider.getChildren(providersGroup);
        const deepSeekItem = providerItems.find(item => item.label === 'DeepSeek');

        expect(deepSeekItem?.description).toBe('Active');
        expect(deepSeekItem?.command).toEqual({
            command: 'autocode.model.useProvider',
            title: 'Use DeepSeek',
            arguments: ['deepseek']
        });
    });
});
