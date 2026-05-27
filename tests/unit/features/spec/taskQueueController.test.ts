import * as vscode from 'vscode';
import {
    AutoTaskQueueStartBlockedError,
    findRecoverableAutoTaskQueues,
    getAutoTaskQueueDiagnostics,
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
            queueRunId: expect.stringMatching(/^queue-/),
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

    test('preserves the queue run id across waiting and completion states', async () => {
        const started = await controller.start(documentUri, 'autocode.spec.implAllTasks');
        const waiting = await controller.waitForTask(documentUri, 'autocode.spec.implAllTasks', {
            lineNumber: 1,
            taskDescription: '1. First task'
        });

        expect(waiting.queueRunId).toBe(started.queueRunId);

        await controller.complete(documentUri, 'autocode.spec.implAllTasks');
        const completed = await controller.get(documentUri, 'autocode.spec.implAllTasks');
        expect(completed?.queueRunId).toBe(started.queueRunId);
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

    test('matches a queued batch by line, description, signal path, and token', async () => {
        const batchTasks = [
            {
                lineNumber: 1,
                taskDescription: '1. First task',
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1'
            },
            {
                lineNumber: 4,
                taskDescription: '2. Second task',
                completionSignalPath: 'signal-2',
                completionSignalToken: 'run-2'
            }
        ];
        await controller.start(documentUri, 'autocode.spec.implAllTasksParallel');
        await controller.waitForBatch(documentUri, 'autocode.spec.implAllTasksParallel', batchTasks);

        await expect(controller.getMatchingBatchQueue(documentUri, batchTasks, 'autocode.spec.implAllTasksParallel'))
            .resolves
            .toEqual(expect.objectContaining({ status: 'waiting_for_signal' }));
        const persisted = await controller.get(documentUri, 'autocode.spec.implAllTasksParallel');
        await expect(controller.getMatchingBatchQueue(documentUri, batchTasks, 'autocode.spec.implAllTasksParallel', `${persisted?.queueRunId}-stale`))
            .resolves
            .toBeUndefined();
        await expect(controller.getMatchingBatchQueue(documentUri, [
            batchTasks[0],
            { ...batchTasks[1], completionSignalToken: 'stale-run' }
        ], 'autocode.spec.implAllTasksParallel')).resolves.toBeUndefined();
    });

    test('does not match stale cached batch state after another controller clears the queue', async () => {
        const batchTasks = [
            {
                lineNumber: 1,
                taskDescription: '1. First task',
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1'
            }
        ];
        await controller.start(documentUri, 'autocode.spec.implAllTasksParallel');
        await controller.waitForBatch(documentUri, 'autocode.spec.implAllTasksParallel', batchTasks);

        const freshController = new TaskQueueController(vscode.window.createOutputChannel('fresh'));
        await freshController.clear(documentUri);

        await expect(controller.getMatchingBatchQueue(documentUri, batchTasks, 'autocode.spec.implAllTasksParallel'))
            .resolves
            .toBeUndefined();
    });

    test('pauses a partial batch with only the unresolved task retained', async () => {
        const batchTasks = [
            {
                lineNumber: 1,
                taskDescription: '1. First task',
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1'
            },
            {
                lineNumber: 4,
                taskDescription: '2. Failed task',
                completionSignalPath: 'signal-2',
                completionSignalToken: 'run-2'
            }
        ];
        await controller.start(documentUri, 'autocode.spec.implAllTasksParallel');
        await controller.waitForBatch(documentUri, 'autocode.spec.implAllTasksParallel', batchTasks);

        await controller.pause(documentUri, 'autocode.spec.implAllTasksParallel', 'One task failed.', [4]);

        const record = JSON.parse(files.get(normalize('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.json'))!.toString());
        expect(record).toEqual(expect.objectContaining({
            status: 'paused',
            pauseReason: 'One task failed.'
        }));
        expect(record.currentTask).toBeUndefined();
        expect(record.batchTasks).toEqual([batchTasks[1]]);
    });

    test('does not consume stale cached single-task state after another controller clears the queue', async () => {
        await controller.start(documentUri, 'autocode.spec.implAllTasks');
        await controller.waitForTask(documentUri, 'autocode.spec.implAllTasks', {
            lineNumber: 1,
            taskDescription: '1. First task'
        });

        const freshController = new TaskQueueController(vscode.window.createOutputChannel('fresh'));
        await freshController.clear(documentUri);

        await expect(controller.consumeContinuation(documentUri, 1, 'automatic verification'))
            .resolves
            .toBeUndefined();
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

    test('serializes duplicate starts across controller instances', async () => {
        let notifyFirstWriteStarted: () => void = () => undefined;
        let releaseFirstWrite: () => void = () => undefined;
        const firstWriteStarted = new Promise<void>(resolve => {
            notifyFirstWriteStarted = resolve;
        });
        const allowFirstWrite = new Promise<void>(resolve => {
            releaseFirstWrite = resolve;
        });
        let queueWriteCount = 0;
        (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(async (uri: vscode.Uri, content: Uint8Array) => {
            if (uri.fsPath.endsWith('task-queue.json')) {
                queueWriteCount += 1;
                notifyFirstWriteStarted();
                if (queueWriteCount === 1) {
                    await allowFirstWrite;
                }
            }

            files.set(normalize(uri.fsPath), Buffer.from(content));
        });

        const firstController = new TaskQueueController(vscode.window.createOutputChannel('first'));
        const secondController = new TaskQueueController(vscode.window.createOutputChannel('second'));
        const firstStart = firstController.start(documentUri, 'autocode.spec.implAllTasks');
        await firstWriteStarted;

        const secondStart = secondController.start(documentUri, 'autocode.spec.implAllTasksParallel');
        await Promise.resolve();
        expect(queueWriteCount).toBe(1);

        releaseFirstWrite();
        await expect(firstStart).resolves.toEqual(expect.objectContaining({
            commandId: 'autocode.spec.implAllTasks'
        }));
        await expect(secondStart).rejects.toBeInstanceOf(AutoTaskQueueStartBlockedError);
        expect(queueWriteCount).toBe(1);
    });

    test('creates and releases the persisted queue lock around writes', async () => {
        await controller.start(documentUri, 'autocode.spec.implAllTasks');

        expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: expect.stringContaining('task-queue.lock') }),
            expect.any(Buffer)
        );
        expect(files.has(normalize('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.lock'))).toBe(false);
    });

    test('reports queue diagnostics with run id, queued task, and lock state', async () => {
        const now = Date.parse('2026-05-27T00:10:00.000Z');
        const statePath = normalize('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.json');
        const lockPath = normalize('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.lock');
        files.set(statePath, Buffer.from(JSON.stringify({
            version: 1,
            queueRunId: 'queue-current',
            taskFilePath: documentUri.fsPath,
            commandId: 'autocode.spec.implAllTasks',
            status: 'waiting_for_signal',
            startedAt: '2026-05-27T00:00:00.000Z',
            updatedAt: '2026-05-27T00:09:00.000Z',
            currentTask: {
                lineNumber: 1,
                taskDescription: '1. Waiting task',
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1'
            }
        })));
        files.set(lockPath, Buffer.from(JSON.stringify({
            owner: 'queue-lock-owner',
            createdAt: '2026-05-27T00:09:30.000Z'
        })));

        const diagnostics = await getAutoTaskQueueDiagnostics(documentUri, now);

        expect(diagnostics.record?.queueRunId).toBe('queue-current');
        expect(diagnostics.summary).toEqual(expect.objectContaining({
            statusText: 'waiting for signal',
            taskCount: 1,
            currentTaskDescription: '1. Waiting task'
        }));
        expect(diagnostics.lock).toEqual(expect.objectContaining({
            status: 'active',
            owner: 'queue-lock-owner',
            ageMs: 30000
        }));
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
