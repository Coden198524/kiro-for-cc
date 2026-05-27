import * as vscode from 'vscode';
import {
    AutoTaskQueueStartBlockedError,
    findRecoverableAutoTaskQueues,
    getAutoTaskQueueSummary,
    TaskQueueController
} from '../../../../src/features/spec/taskQueueController';

jest.mock('vscode');

describe('TaskQueueController', () => {
    const documentUri = {
        fsPath: '/mock/workspace/.autocode/specs/demo/tasks.md',
        path: '/mock/workspace/.autocode/specs/demo/tasks.md',
        scheme: 'file'
    } as vscode.Uri;
    let files: Map<string, Buffer>;
    let controller: TaskQueueController;

    beforeEach(() => {
        jest.clearAllMocks();
        files = new Map();
        (vscode.Uri as any).file = (filePath: string) => ({
            fsPath: filePath,
            path: filePath,
            scheme: 'file'
        });
        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(async (uri: vscode.Uri, content: Uint8Array) => {
            files.set(normalize(uri.fsPath), Buffer.from(content));
        });
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            const content = files.get(normalize(uri.fsPath));
            if (!content) {
                throw new Error(`missing ${uri.fsPath}`);
            }
            return content;
        });
        (vscode.workspace.fs.delete as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            files.delete(normalize(uri.fsPath));
        });
        controller = new TaskQueueController(vscode.window.createOutputChannel('test'));
    });

    test('persists the current task while waiting for completion', async () => {
        await controller.start(documentUri, 'autocode.spec.implAllTasks');
        await controller.waitForTask(documentUri, 'autocode.spec.implAllTasks', {
            lineNumber: 4,
            taskDescription: '2.1 Implement queue state',
            completionSignalPath: '/mock/workspace/.autocode/specs/demo/.autocode/task-completion-5.json',
            completionSignalToken: 'run-5'
        });

        const record = JSON.parse(files.get(normalize('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.json'))!.toString());
        expect(record).toEqual(expect.objectContaining({
            version: 1,
            taskFilePath: documentUri.fsPath,
            commandId: 'autocode.spec.implAllTasks',
            status: 'waiting_for_signal'
        }));
        expect(record.currentTask).toEqual(expect.objectContaining({
            lineNumber: 4,
            taskDescription: '2.1 Implement queue state',
            completionSignalToken: 'run-5'
        }));
    });

    test('consumes a matching continuation only once', async () => {
        await controller.start(documentUri, 'autocode.spec.implAllTasks');
        await controller.waitForTask(documentUri, 'autocode.spec.implAllTasks', {
            lineNumber: 1,
            taskDescription: '1. First task'
        });

        await expect(controller.consumeContinuation(documentUri, 2, 'wrong line')).resolves.toBeUndefined();
        await expect(controller.consumeContinuation(documentUri, 1, 'verification')).resolves.toBe('autocode.spec.implAllTasks');
        await expect(controller.consumeContinuation(documentUri, 1, 'verification')).resolves.toBeUndefined();
        expect(files.has(normalize('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.json'))).toBe(false);
    });

    test('blocks duplicate queue starts unless forced', async () => {
        await controller.start(documentUri, 'autocode.spec.implAllTasks');

        await expect(controller.start(documentUri, 'autocode.spec.implAllTasksParallel'))
            .rejects
            .toBeInstanceOf(AutoTaskQueueStartBlockedError);

        await controller.start(documentUri, 'autocode.spec.implAllTasksParallel', { force: true });
        const record = await controller.get(documentUri);
        expect(record?.commandId).toBe('autocode.spec.implAllTasksParallel');
        expect(record?.status).toBe('running');
    });

    test('summarizes stale waiting queues', async () => {
        await controller.start(documentUri, 'autocode.spec.implAllTasks');
        await controller.waitForTask(documentUri, 'autocode.spec.implAllTasks', {
            lineNumber: 1,
            taskDescription: '1. Waiting task'
        });

        const record = await controller.get(documentUri);
        expect(record).toBeDefined();
        const summary = getAutoTaskQueueSummary(record!, Date.parse(record!.updatedAt) + 7 * 60 * 60 * 1000);

        expect(summary).toEqual(expect.objectContaining({
            statusText: 'waiting for signal',
            taskCount: 1,
            currentTaskDescription: '1. Waiting task',
            stale: true
        }));
    });

    test('can restore a persisted queue when memory state is not available', async () => {
        const statePath = normalize('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.json');
        files.set(statePath, Buffer.from(JSON.stringify({
            version: 1,
            taskFilePath: documentUri.fsPath,
            commandId: 'autocode.spec.implAllTasksParallel',
            status: 'paused',
            startedAt: '2026-05-27T00:00:00.000Z',
            updatedAt: '2026-05-27T00:00:00.000Z',
            currentTask: {
                lineNumber: 3,
                taskDescription: '2. Paused task'
            },
            pauseReason: 'Verification failed.'
        })));

        const freshController = new TaskQueueController(vscode.window.createOutputChannel('test'));
        await expect(freshController.consumeContinuation(documentUri, 3, 'manual Mark Done')).resolves.toBe('autocode.spec.implAllTasksParallel');
        expect(files.has(statePath)).toBe(false);
    });

    test('finds recoverable queues under configured spec directories', async () => {
        const queuePath = normalize('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.json');
        const completedQueuePath = normalize('/mock/workspace/.autocode/specs/done/.autocode/task-queue.json');
        files.set(queuePath, Buffer.from(JSON.stringify({
            version: 1,
            taskFilePath: '/mock/workspace/.autocode/specs/demo/tasks.md',
            commandId: 'autocode.spec.implAllTasks',
            status: 'paused',
            startedAt: '2026-05-27T00:00:00.000Z',
            updatedAt: '2026-05-27T00:00:00.000Z',
            currentTask: {
                lineNumber: 1,
                taskDescription: '1. Paused task'
            }
        })));
        files.set(completedQueuePath, Buffer.from(JSON.stringify({
            version: 1,
            taskFilePath: '/mock/workspace/.autocode/specs/done/tasks.md',
            commandId: 'autocode.spec.implAllTasks',
            status: 'completed',
            startedAt: '2026-05-27T00:00:00.000Z',
            updatedAt: '2026-05-27T00:00:00.000Z'
        })));
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['demo', vscode.FileType.Directory],
            ['done', vscode.FileType.Directory],
            ['README.md', vscode.FileType.File]
        ]);

        const queues = await findRecoverableAutoTaskQueues(
            [{ uri: vscode.Uri.file('/mock/workspace'), name: 'mock-workspace', index: 0 }],
            '.autocode/specs'
        );

        expect(queues).toHaveLength(1);
        expect(queues[0].specName).toBe('demo');
        expect(queues[0].workspaceFolderName).toBe('mock-workspace');
        expect(normalize(queues[0].documentUri.fsPath)).toBe(normalize('/mock/workspace/.autocode/specs/demo/tasks.md'));
        expect(queues[0].record.status).toBe('paused');
        expect(files.has(completedQueuePath)).toBe(false);
    });

    function normalize(filePath: string): string {
        return filePath.replace(/\\/g, '/').toLowerCase();
    }
});
