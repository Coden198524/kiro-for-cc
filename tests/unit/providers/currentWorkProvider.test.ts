import * as vscode from 'vscode';
import { CurrentWorkProvider } from '../../../src/providers/currentWorkProvider';
import { ConfigManager } from '../../../src/utils/configManager';

jest.mock('vscode');

describe('CurrentWorkProvider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (ConfigManager as any).instance = undefined;
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

    test('shows speed action and empty work state when no queue exists', async () => {
        const provider = new CurrentWorkProvider(vscode.window.createOutputChannel('test'));

        const items = await provider.getChildren();

        expect(items.map(item => item.label)).toEqual([
            'Development Speed Preset',
            'No active task queue'
        ]);
        expect(items[0].command?.command).toBe('autocode.settings.selectDevelopmentSpeedPreset');
        expect(items[1].iconPath).toEqual(new vscode.ThemeIcon('pass'));
    });

    test('shows active queue status, actions, and queued tasks', async () => {
        const provider = new CurrentWorkProvider(vscode.window.createOutputChannel('test'));
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['demo', vscode.FileType.Directory]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            version: 1,
            queueRunId: 'queue-1',
            taskFilePath: '/mock/workspace/.autocode/specs/demo/tasks.md',
            commandId: 'autocode.spec.implAllTasksParallel',
            status: 'paused',
            startedAt: '2026-05-27T00:00:00.000Z',
            updatedAt: '2026-05-27T00:01:00.000Z',
            batchTasks: [
                {
                    lineNumber: 2,
                    taskDescription: '1.1 First failed task'
                }
            ],
            pauseReason: 'Verification failed.'
        })));

        const rootItems = await provider.getChildren();
        const queueItem = rootItems.find(item => item.queue)!;
        const queueChildren = await provider.getChildren(queueItem);

        expect(queueItem.label).toBe('demo');
        expect(queueItem.description).toBe('paused - 1 task(s)');
        expect(queueItem.iconPath).toEqual(new vscode.ThemeIcon('debug-pause'));
        expect(queueItem.command?.command).toBe('autocode.spec.showTaskQueueDetails');
        expect(queueChildren.map(item => item.label)).toEqual(expect.arrayContaining([
            'Status: paused',
            'Queued tasks: 1',
            'Current batch: 1',
            'Pause reason: Verification failed.',
            'Resume Queue',
            'Open Details',
            'Cancel Queue',
            'Pending/failed 3: 1.1 First failed task'
        ]));
    });
});
