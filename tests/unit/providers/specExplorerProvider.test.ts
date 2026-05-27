import * as vscode from 'vscode';
import { SpecExplorerProvider } from '../../../src/providers/specExplorerProvider';

jest.mock('vscode');

describe('SpecExplorerProvider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.Uri as any).file = (filePath: string) => ({
            fsPath: filePath,
            path: filePath,
            scheme: 'file'
        });
        (vscode.workspace as any).workspaceFolders = [{
            uri: vscode.Uri.file('/mock/workspace'),
            name: 'mock-workspace',
            index: 0
        }];
        (vscode.workspace.fs.readDirectory as jest.Mock).mockRejectedValue(new Error('missing directory'));
        (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error('missing file'));
    });

    test('shows fixed Specs action rows before specs so commands are visible without title-bar space', async () => {
        const provider = new SpecExplorerProvider(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.window.createOutputChannel('test')
        );
        provider.setSpecManager({
            getSpecList: jest.fn().mockResolvedValue(['demo-spec']),
            getSpecBasePath: jest.fn().mockResolvedValue('.autocode/specs')
        } as any);

        const children = await provider.getChildren();

        expect(children.map(item => item.label)).toEqual([
            'Initialize Project Context',
            'Create New Spec',
            'Create Spec with Agents',
            'demo-spec'
        ]);
        expect(children[0].command?.command).toBe('autocode.steering.generateInitial');
        expect(children[1].command?.command).toBe('autocode.spec.create');
        expect(children[2].command?.command).toBe('autocode.spec.createWithAgents');
        expect(children[0].iconPath).toEqual(new vscode.ThemeIcon('repo'));
        expect(children[1].iconPath).toEqual(new vscode.ThemeIcon('plus'));
        expect(children[2].iconPath).toEqual(new vscode.ThemeIcon('sparkle'));
    });

    test('shows recoverable auto task queue action when persisted queues exist', async () => {
        const provider = new SpecExplorerProvider(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.window.createOutputChannel('test')
        );
        provider.setSpecManager({
            getSpecList: jest.fn().mockResolvedValue(['demo-spec']),
            getSpecBasePath: jest.fn().mockResolvedValue('.autocode/specs')
        } as any);
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['demo-spec', vscode.FileType.Directory]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            version: 1,
            taskFilePath: '/mock/workspace/.autocode/specs/demo-spec/tasks.md',
            commandId: 'autocode.spec.implAllTasks',
            status: 'paused',
            startedAt: '2026-05-27T00:00:00.000Z',
            updatedAt: '2026-05-27T00:00:00.000Z',
            currentTask: {
                lineNumber: 1,
                taskDescription: '1. Paused task'
            }
        })));

        const children = await provider.getChildren();

        expect(children.map(item => item.label)).toEqual([
            'Initialize Project Context',
            'Create New Spec',
            'Create Spec with Agents',
            'Interrupted Auto Queues (1)',
            'demo-spec'
        ]);
        expect(children[3].command?.command).toBe('autocode.spec.showTaskQueues');
        expect(children[3].iconPath).toEqual(new vscode.ThemeIcon('debug-continue'));
        expect(children[3].description).toBe('recover');
    });
});
