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

    test('shows active auto task queue status and details when persisted queues exist', async () => {
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
            batchTasks: [
                {
                    lineNumber: 1,
                    taskDescription: '1. Paused task'
                },
                {
                    lineNumber: 4,
                    taskDescription: '2. Failed task'
                }
            ],
            pauseReason: 'One or more tasks failed verification.'
        })));

        const children = await provider.getChildren();

        expect(children.map(item => item.label)).toEqual([
            'Initialize Project Context',
            'Create New Spec',
            'Create Spec with Agents',
            'Auto Task Queues (1)',
            'demo-spec'
        ]);
        expect(children[3].command?.command).toBe('autocode.spec.showTaskQueues');
        expect(children[3].iconPath).toEqual(new vscode.ThemeIcon('list-tree'));
        expect(children[3].description).toBe('active');

        const queueItems = await provider.getChildren(children[3] as any);
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0].label).toBe('demo-spec');
        expect(queueItems[0].description).toBe('paused - 2 task(s) - 2 pending/failed');
        expect(queueItems[0].iconPath).toEqual(new vscode.ThemeIcon('debug-pause'));
        expect(queueItems[0].command?.command).toBe('autocode.spec.showTaskQueueDetails');

        const detailItems = await provider.getChildren(queueItems[0] as any);
        expect(detailItems.map(item => item.label)).toEqual(expect.arrayContaining([
            'Status: paused',
            'Queued tasks: 2',
            'Current batch: 2 task(s)',
            'Pause reason: One or more tasks failed verification.',
            'Pending/failed 2: 1. Paused task',
            'Pending/failed 5: 2. Failed task'
        ]));
    });
});
