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

    test('reconciles only requested task line signals when line numbers are provided', async () => {
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

        const result = await service.reconcileTaskCompletionSignals(taskFilePath, { lineNumbers: [6] });

        expect(result).toEqual({ detected: 1, verified: 1 });
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledTimes(1);
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 6,
            taskDescription: '2. Second task'
        });
    });

    test('reconciles a drifted signal file against the current task line', async () => {
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['task-completion-3.json', vscode.FileType.File]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: 'stale task description',
            runId: 'run-1'
        })));
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValueOnce({
            lineCount: 5,
            lineAt: jest.fn((lineNumber: number) => ({
                text: lineNumber === 4 ? '- [-] 1. Drifted task' : '# Tasks'
            }))
        });

        const result = await service.reconcileTaskCompletionSignals(taskFilePath, {
            lineNumbers: [4],
            expectedRunIdsByLineNumber: { 4: 'run-1' },
            taskLineNumbersBySignalLineNumber: { 2: 4 }
        });

        expect(result).toEqual({ detected: 1, verified: 1 });
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 4,
            taskDescription: '1. Drifted task'
        });
    });

    test('ignores reconciled signals with a mismatched expected run id', async () => {
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['task-completion-3.json', vscode.FileType.File]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task',
            runId: 'old-run'
        })));

        const result = await service.reconcileTaskCompletionSignals(taskFilePath, {
            lineNumbers: [2],
            expectedRunIdsByLineNumber: { 2: 'current-run' }
        });

        expect(result).toEqual({ detected: 1, verified: 0 });
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();
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

    test('parses completion signals with a UTF-8 BOM as valid JSON', async () => {
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['task-completion-3.json', vscode.FileType.File]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(`\uFEFF${JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        })}`));

        const result = await service.reconcileTaskCompletionSignals(taskFilePath);

        expect(result).toEqual({ detected: 1, verified: 1 });
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        });
        expect(outputChannel.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('Failed to parse completion signal JSON'));
    });

    test('uses filename line number and current task line when payload omits description', async () => {
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['task-completion-2.json', vscode.FileType.File]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification'
        })));
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValueOnce({
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

    test('prefers the registered task file and signal filename over stale payload fields', async () => {
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['task-completion-3.json', vscode.FileType.File]
        ]);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath: 'E:\\wrong\\spec\\tasks.md',
            lineNumber: 99,
            taskDescription: 'stale task description'
        })));
        (vscode.workspace.openTextDocument as jest.Mock).mockImplementationOnce(async (uri: vscode.Uri) => {
            expect(uri.fsPath).toBe(taskFilePath);
            return {
                lineCount: 3,
                lineAt: jest.fn((lineNumber: number) => ({
                    text: lineNumber === 2 ? '- [-] 1. Current task description' : '# Tasks'
                }))
            };
        });

        const result = await service.reconcileTaskCompletionSignals(taskFilePath);

        expect(result).toEqual({ detected: 1, verified: 1 });
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. Current task description'
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
        }, terminal);
        expect(watcherDispose).toHaveBeenCalled();
    });

    test('ignores a batch completion signal with a mismatched registered run id', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('tasks');
        let closeHandler: ((terminal: vscode.Terminal) => Promise<void>) | undefined;

        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('missing signal'));
        (vscode.window.onDidCloseTerminal as jest.Mock).mockImplementation((handler) => {
            closeHandler = handler;
            return { dispose: jest.fn() };
        });
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task',
            runId: 'old-run'
        })));

        const signalPath = `${signalDir}/task-completion-3.json`;
        const completion = service.registerTaskCompletionSignals(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            terminal,
            taskFilePath,
            [signalPath],
            {
                expectedRunIdsBySignalPath: {
                    [signalPath]: 'current-run'
                }
            }
        );

        await closeHandler?.(terminal);
        await jest.advanceTimersByTimeAsync(10000);

        await expect(completion).resolves.toBe(false);
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();
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
        }, terminal);
        expect(watcherDispose).toHaveBeenCalled();
    });

    test('verifies a single completion signal that already exists when registered', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;

        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        })));
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValueOnce({
            lineCount: 3,
            lineAt: jest.fn((lineNumber: number) => ({
                text: lineNumber === 2 ? '- [-] 1. First task' : '# Tasks'
            }))
        });

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

        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(500);

        await expect(completion).resolves.toBe(true);
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        }, terminal);
        expect(vscode.window.withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: vscode.ProgressLocation.Notification,
                title: expect.stringContaining('AutoCode verifying task 3')
            }),
            expect.any(Function)
        );
    });

    test('uses Chinese progress and warning messages for Chinese task completion verification', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;

        verifier.verifyAndMarkDone.mockResolvedValue(false);
        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '3.3 实现配置加载启动步骤'
        })));
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValueOnce({
            lineCount: 3,
            lineAt: jest.fn((lineNumber: number) => ({
                text: lineNumber === 2 ? '- [-] 3.3 实现配置加载启动步骤' : '# Tasks'
            }))
        });

        const completion = service.registerTaskCompletion(
            context,
            terminal,
            {
                taskFilePath,
                lineNumber: 2,
                taskDescription: '3.3 实现配置加载启动步骤'
            },
            `${signalDir}/task-completion-3.json`
        );

        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(500);

        await expect(completion).resolves.toBe(false);
        expect(vscode.window.withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                title: expect.stringContaining('AutoCode 正在验证任务 3: 3.3 实现配置加载启动步骤')
            }),
            expect.any(Function)
        );
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('任务完成验证未通过：3.3 实现配置加载启动步骤');
    });

    test('shows a warning when single-task completion verification does not pass', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;

        verifier.verifyAndMarkDone.mockResolvedValue(false);
        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        })));
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValueOnce({
            lineCount: 3,
            lineAt: jest.fn((lineNumber: number) => ({
                text: lineNumber === 2 ? '- [-] 1. First task' : '# Tasks'
            }))
        });

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
        await jest.advanceTimersByTimeAsync(500);

        await expect(completion).resolves.toBe(false);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Task completion verification did not pass'));
    });

    test('ignores an existing completion signal with a stale runId', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;

        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task',
            runId: 'old-run'
        })));
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValueOnce({
            lineCount: 3,
            lineAt: jest.fn((lineNumber: number) => ({
                text: lineNumber === 2 ? '- [-] 1. First task' : '# Tasks'
            }))
        });

        const signalPath = `${signalDir}/task-completion-3.json`;
        const completion = service.registerTaskCompletion(
            context,
            terminal,
            {
                taskFilePath,
                lineNumber: 2,
                taskDescription: '1. First task'
            },
            signalPath,
            'current-run'
        );
        let resolved = false;
        completion?.then(() => {
            resolved = true;
        });

        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(500);

        expect(resolved).toBe(false);
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();
    });

    test('accepts a completion signal without runId when it was written during the current run', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(100000));
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
        (vscode.workspace.fs.stat as jest.Mock)
            .mockRejectedValueOnce(new Error('not written yet'))
            .mockResolvedValue({
                type: vscode.FileType.File,
                ctime: 101000,
                mtime: 101000,
                size: 128
            });
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        })));
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValueOnce({
            lineCount: 3,
            lineAt: jest.fn((lineNumber: number) => ({
                text: lineNumber === 2 ? '- [-] 1. First task' : '# Tasks'
            }))
        });

        const signalPath = `${signalDir}/task-completion-3.json`;
        const completion = service.registerTaskCompletion(
            context,
            terminal,
            {
                taskFilePath,
                lineNumber: 2,
                taskDescription: '1. First task'
            },
            signalPath,
            'current-run'
        );

        await jest.advanceTimersByTimeAsync(0);
        createHandler?.(vscode.Uri.file(signalPath));
        await jest.advanceTimersByTimeAsync(500);

        await expect(completion).resolves.toBe(true);
        expect(verifier.verifyAndMarkDone).toHaveBeenCalledWith({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1. First task'
        }, terminal);
    });

    test('ignores an old completion signal without runId when current run expects a token', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(100000));
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;

        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            dispose: jest.fn()
        });
        (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({
            type: vscode.FileType.File,
            ctime: 90000,
            mtime: 90000,
            size: 128
        });
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
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
            signalPath,
            'current-run'
        );
        let resolved = false;
        completion?.then(() => {
            resolved = true;
        });

        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(500);

        expect(resolved).toBe(false);
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();
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
        }, terminal);
    });

    test('keeps waiting after shell end when no completion signal arrives', async () => {
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
        let resolved = false;
        completion?.then(() => {
            resolved = true;
        });

        await shellEndHandler?.({ terminal });
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(10000);

        expect(resolved).toBe(false);
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();
    });

    test('resolves false after terminal close when no completion signal arrives', async () => {
        jest.useFakeTimers();
        const terminal = vscode.window.createTerminal('task');
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
        let closeHandler: ((terminal: vscode.Terminal) => Promise<void>) | undefined;

        (vscode.window.onDidCloseTerminal as jest.Mock).mockImplementation(handler => {
            closeHandler = handler;
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
                taskDescription: '1. Missing signal task'
            },
            signalPath
        );

        await closeHandler?.(terminal);
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(10000);

        await expect(completion).resolves.toBe(false);
        expect(verifier.verifyAndMarkDone).not.toHaveBeenCalled();
    });

    test('waits for a completion signal after terminal close before pausing', async () => {
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
        }, terminal);

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
