import * as vscode from 'vscode';
import { SettingsManager } from '../../../../src/features/settings/settingsManager';
import { ConfigManager } from '../../../../src/utils/configManager';

jest.mock('vscode');

describe('SettingsManager model selection', () => {
    let configValues: Record<string, unknown>;
    let update: jest.Mock;
    let writeFilePayload: string | undefined;
    let manager: SettingsManager;

    beforeEach(() => {
        jest.clearAllMocks();
        configValues = {};
        writeFilePayload = undefined;
        update = jest.fn(async (key: string, value: unknown) => {
            configValues[key] = value;
        });
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
            update
        }));
        (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error('missing settings'));
        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(async (_uri: vscode.Uri, content: Buffer) => {
            writeFilePayload = content.toString();
        });
        manager = new SettingsManager(vscode.window.createOutputChannel('test'));
    });

    test('selects a model provider from quick pick and persists it', async () => {
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            label: 'Codex',
            providerId: 'codex'
        });

        const changed = await manager.selectAgentProvider();

        expect(changed).toBe(true);
        expect(update).toHaveBeenCalledWith('agent.provider', 'codex', vscode.ConfigurationTarget.Workspace);
        expect(JSON.parse(writeFilePayload ?? '{}').agent.provider).toBe('codex');
    });

    test('sets and clears the active model id', async () => {
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('gpt-5.5');

        expect(await manager.setAgentModel()).toBe(true);
        expect(update).toHaveBeenCalledWith('agent.model', 'gpt-5.5', vscode.ConfigurationTarget.Workspace);
        expect(JSON.parse(writeFilePayload ?? '{}').agent.model).toBe('gpt-5.5');

        expect(await manager.clearAgentModel()).toBe(true);
        expect(update).toHaveBeenCalledWith('agent.model', '', vscode.ConfigurationTarget.Workspace);
        expect(JSON.parse(writeFilePayload ?? '{}').agent.model).toBe('');
    });

    test('applies development speed presets to VS Code and project settings', async () => {
        expect(await manager.applyDevelopmentSpeedPreset('fast')).toBe(true);

        expect(update).toHaveBeenCalledWith('spec.deferTaskVerification', true, vscode.ConfigurationTarget.Workspace);
        expect(update).toHaveBeenCalledWith('spec.taskCompletionVerificationMode', 'fast', vscode.ConfigurationTarget.Workspace);
        expect(update).toHaveBeenCalledWith('spec.autoMarkTaskDone', true, vscode.ConfigurationTarget.Workspace);
        expect(JSON.parse(writeFilePayload ?? '{}').spec).toEqual(expect.objectContaining({
            deferTaskVerification: true,
            taskCompletionVerificationMode: 'fast',
            autoMarkTaskDone: true
        }));
    });

    test('selects UI language and persists it', async () => {
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            label: '中文',
            language: 'zh-CN'
        });

        expect(await manager.selectUiLanguage()).toBe(true);

        expect(update).toHaveBeenCalledWith('ui.language', 'zh-CN', vscode.ConfigurationTarget.Workspace);
        expect(JSON.parse(writeFilePayload ?? '{}').ui.language).toBe('zh-CN');
    });
});
