import * as vscode from 'vscode';
import { TaskCompletionService } from '../../../../src/features/spec/taskCompletionService';
import { TaskCompletionVerifier } from '../../../../src/features/spec/taskCompletionVerifier';

describe('TaskCompletionService', () => {
    const taskFilePath = '/mock/workspace/.autocode/specs/demo/tasks.md';
    const signalDir = '/mock/workspace/.autocode/specs/demo/.autocode';
    let verifier: jest.Mocked<Pick<TaskCompletionVerifier, 'isEnabled' | 'verifyAndMarkDone'>>;
    let outputChannel: vscode.OutputChannel;
    let service: TaskCompletionService;

    beforeEach(() => {
        jest.clearAllMocks();

        verifier = {
            isEnabled: jest.fn(() => true),
            verifyAndMarkDone: jest.fn(async (_request) => true)
        };
        outputChannel = vscode.window.createOutputChannel('test');
        service = new TaskCompletionService(verifier as unknown as TaskCompletionVerifier, outputChannel);

        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['task-completion-3.json', vscode.FileType.File],
            ['task-completion-7.json', vscode.FileType.File],
            ['task-sessions.json', vscode.FileType.File],
            ['session-prompts', vscode.FileType.Directory]
        ]);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('reconciles existing completion signals using payload task descriptions', async () => {
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            if (uri.fsPath.endsWith('task-completion-3.json')) {
                return Buffer.from(JSON.stringify({
                    status: 'ready_for_verification',
                    taskFilePath,
                    lineNumber: 2,
                    taskDescription: '1. First task'
                }));
            }

            return Buffer.from(JSON.stringify({
                status: 'ready_for_verification',
                taskFilePath,
                lineNumber: 6,
                taskDescription: '2. Second task'
            }));
        });

        const result = await service.reconcileTaskCompletionSignals(taskFilePath);

        expect(result).toEqual({ detected: 2, verified: 2 });
        expect(verifier.verifyAndMarkDone).toHaveBeenNthCalledWith(1, {
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        });
        expect(verifier.verifyAndMarkDone).toHaveBeenNthCalledWith(2, {
            taskFilePath,
            lineNumber: 6,
            taskDescription: '2. Second task'
        });
    });

    test('falls back to loose signal parsing when JSON is malformed', async () => {
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['task-completion-3.json', vscode.FileType.File]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from([
            '{',
            '"status": "ready_for_verification",',
            `"taskFilePath": "${taskFilePath}",`,
            '"lineNumber": 2,',
            '"taskDescription": "1. First task"'
        ].join('\n')));

        const result = await service.reconcileTaskCompletionSignals(taskFilePath);

        expect(result).toEqual({ detected: 1, verified: 1 });
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        });
    });

    test('uses filename line number and current task line when payload omits description', async () => {
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['task-completion-2.json', vscode.FileType.File]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification'
        })));
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
            lineCount: 2,
            lineAt: jest.fn((lineNumber: number) => ({
                text: lineNumber === 1 ? '- [-] 1. Fallback task' : '# Tasks'
            }))
        });

        const result = await service.reconcileTaskCompletionSignals(taskFilePath);

        expect(result).toEqual({ detected: 1, verified: 1 });
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 1,
            taskDescription: '1. Fallback task'
        });
    });

    test('ignores signals that are not ready for verification', async () => {
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['task-completion-3.json', vscode.FileType.File]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'draft',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        })));

        const result = await service.reconcileTaskCompletionSignals(taskFilePath);

        expect(result).toEqual({ detected: 1, verified: 0 });
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();
    });

    test('skips reconciliation when auto mark is disabled', async () => {
        verifier.isEnabled.mockReturnValue(false);

        const result = await service.reconcileTaskCompletionSignals(taskFilePath);

        expect(result).toEqual({ detected: 0, verified: 0 });
        expect(vscode.workspace.fs.readDirectory).not.toHaveBeenCalled();
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();
    });

    test('verifies existing batch completion signals before disposing watchers on terminal close', async () => {
        const terminal = vscode.window.createTerminal('tasks');
        const watcherDispose = jest.fn();
        let closeHandler: ((terminal: vscode.Terminal) => Promise<void>) | undefined;

        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            dispose: watcherDispose
        });
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('missing signal'));
        (vscode.window.onDidCloseTerminal as jest.Mock).mockImplementation((handler) => {
            closeHandler = handler;
            return { dispose: jest.fn() };
        });
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            if (uri.fsPath.endsWith('task-completion-3.json')) {
                return Buffer.from(JSON.stringify({
                    status: 'ready_for_verification',
                    taskFilePath,
                    lineNumber: 2,
                    taskDescription: '1. First task'
                }));
            }

            throw new Error(`Unexpected read: ${uri.fsPath}`);
        });

        service.registerTaskCompletionSignals(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            terminal,
            taskFilePath,
            [`${signalDir}/task-completion-3.json`]
        );

        await closeHandler?.(terminal);

        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        });
        expect(watcherDispose).toHaveBeenCalled();
    });

    test('polls for a single completion signal when file watcher events are missed', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
        const watcherDispose = jest.fn();

        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            dispose: watcherDispose
        });
        (vscode.workspace.fs.stat as jest.Mock)
            .mockRejectedValueOnce(new Error('not written yet'))
            .mockResolvedValue(undefined);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        })));

        const completion = service.registerTaskCompletion(
            context,
            terminal,
            {
                taskFilePath,
                lineNumber: 2,
                taskDescription: '1. First task'
            },
            `${signalDir}/task-completion-3.json`
        );

        await jest.advanceTimersByTimeAsync(0);
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(2000);
        await jest.advanceTimersByTimeAsync(500);

        await expect(completion).resolves.toBe(true);
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        });
        expect(watcherDispose).toHaveBeenCalled();
    });

    test('does not consume single-task verification on shell end before the signal exists', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
        let shellEndHandler: ((event: { terminal: vscode.Terminal }) => Promise<void>) | undefined;
        let createHandler: ((uri: vscode.Uri) => void) | undefined;

        (vscode.window.onDidEndTerminalShellExecution as jest.Mock).mockImplementation(handler => {
            shellEndHandler = handler;
            return { dispose: jest.fn() };
        });
        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn((handler) => {
                createHandler = handler;
            }),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not written yet'));
        (vscode.workspace.fs.readFile as jest.Mock)
            .mockRejectedValueOnce(new Error('not written yet'))
            .mockResolvedValue(Buffer.from(JSON.stringify({
                status: 'ready_for_verification',
                taskFilePath,
                lineNumber: 2,
                taskDescription: '1. First task'
            })));

        const signalPath = `${signalDir}/task-completion-3.json`;
        const completion = service.registerTaskCompletion(
            context,
            terminal,
            {
                taskFilePath,
                lineNumber: 2,
                taskDescription: '1. First task'
            },
            signalPath
        );

        await shellEndHandler?.({ terminal });
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();

        createHandler?.(vscode.Uri.file(signalPath));
        await jest.advanceTimersByTimeAsync(500);

        await expect(completion).resolves.toBe(true);
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        });
    });

    test('falls back after shell end when no completion signal arrives', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
        let shellEndHandler: ((event: { terminal: vscode.Terminal }) => Promise<void>) | undefined;

        (vscode.window.onDidEndTerminalShellExecution as jest.Mock).mockImplementation(handler => {
            shellEndHandler = handler;
            return { dispose: jest.fn() };
        });
        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not written yet'));
        (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error('not written yet'));

        const signalPath = `${signalDir}/task-completion-3.json`;
        const completion = service.registerTaskCompletion(
            context,
            terminal,
            {
                taskFilePath,
                lineNumber: 2,
                taskDescription: '1. Fallback task'
            },
            signalPath
        );

        await shellEndHandler?.({ terminal });
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(10000);

        await expect(completion).resolves.toBe(true);
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. Fallback task'
        });
    });

    test('waits for a completion signal after terminal close before fallback verification', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
        let closeHandler: ((terminal: vscode.Terminal) => Promise<void>) | undefined;
        let createHandler: ((uri: vscode.Uri) => void) | undefined;

        (vscode.window.onDidCloseTerminal as jest.Mock).mockImplementation(handler => {
            closeHandler = handler;
            return { dispose: jest.fn() };
        });
        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn((handler) => {
                createHandler = handler;
            }),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not written yet'));
        (vscode.workspace.fs.readFile as jest.Mock)
            .mockRejectedValueOnce(new Error('not written yet'))
            .mockResolvedValue(Buffer.from(JSON.stringify({
                status: 'ready_for_verification',
                taskFilePath,
                lineNumber: 2,
                taskDescription: '1. Signal task'
            })));

        const signalPath = `${signalDir}/task-completion-3.json`;
        const completion = service.registerTaskCompletion(
            context,
            terminal,
            {
                taskFilePath,
                lineNumber: 2,
                taskDescription: '1. Fallback task'
            },
            signalPath
        );

        await closeHandler?.(terminal);
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();

        createHandler?.(vscode.Uri.file(signalPath));
        await jest.advanceTimersByTimeAsync(500);

        await expect(completion).resolves.toBe(true);
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledTimes(1);
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. Signal task'
        });

        await jest.advanceTimersByTimeAsync(10000);
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledTimes(1);
    });

    test('resolves false when a task writes a blocked completion signal', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
        let createHandler: ((uri: vscode.Uri) => void) | undefined;

        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn((handler) => {
                createHandler = handler;
            }),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not written yet'));
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'blocked',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. Blocked task',
            reason: 'windows sandbox: spawn setup refresh'
        })));

        const signalPath = `${signalDir}/task-completion-3.json`;
        const completion = service.registerTaskCompletion(
            context,
            terminal,
            {
                taskFilePath,
                lineNumber: 2,
                taskDescription: '1. Blocked task'
            },
            signalPath
        );

        createHandler?.(vscode.Uri.file(signalPath));
        await jest.advanceTimersByTimeAsync(500);

        await expect(completion).resolves.toBe(false);
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();
    });
});
