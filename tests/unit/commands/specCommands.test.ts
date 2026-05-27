import * as vscode from 'vscode';
import { registerSpecCommands } from '../../../src/commands/specCommands';
import {
    markTaskLinesInProgress,
    markTaskLinesPending,
    readTaskLine,
    updateTaskLineStatus
} from '../../../src/features/spec/taskStatusEditor';

jest.mock('vscode');
jest.mock('../../../src/features/spec/taskStatusEditor', () => ({
    markTaskLinesInProgress: jest.fn(),
    markTaskLinesPending: jest.fn(),
    readTaskLine: jest.fn(),
    updateTaskLineStatus: jest.fn()
}));

describe('registerSpecCommands task execution', () => {
    const documentUri = {
        fsPath: '/mock/workspace/.autocode/specs/demo/tasks.md',
        path: '/mock/workspace/.autocode/specs/demo/tasks.md',
        scheme: 'file'
    } as vscode.Uri;
    let commands: Map<string, (...args: any[]) => Promise<void>>;
    let specManager: any;
    let taskCompletionService: any;
    let outputChannel: vscode.OutputChannel;

    beforeEach(() => {
        jest.clearAllMocks();
        commands = new Map();
        outputChannel = vscode.window.createOutputChannel('test');
        specManager = {
            create: jest.fn(),
            createWithAgents: jest.fn(),
            navigateToDocument: jest.fn(),
            implTask: jest.fn(),
            implAllTasks: jest.fn(),
            implAllTasksParallel: jest.fn(),
            delete: jest.fn()
        };
        taskCompletionService = {
            registerTaskCompletion: jest.fn(),
            registerTaskCompletionSignals: jest.fn(),
            reconcileTaskCompletionSignals: jest.fn()
        };

        (vscode.commands.registerCommand as jest.Mock).mockImplementation((command: string, callback: (...args: any[]) => Promise<void>) => {
            commands.set(command, callback);
            return { dispose: jest.fn() };
        });
        (markTaskLinesInProgress as jest.Mock).mockResolvedValue([]);
        (markTaskLinesPending as jest.Mock).mockResolvedValue([]);
        (readTaskLine as jest.Mock).mockResolvedValue(undefined);
        (updateTaskLineStatus as jest.Mock).mockResolvedValue(undefined);

        registerSpecCommands({
            context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
            specManager,
            specExplorer: { refresh: jest.fn() } as any,
            taskSessionManager: { markCompleted: jest.fn(), showSession: jest.fn() } as any,
            taskCompletionService,
            outputChannel
        });
    });

    test('marks the next task in progress and continues the auto queue after verification', async () => {
        const terminal = vscode.window.createTerminal('all');
        const steps: string[] = [];
        (markTaskLinesInProgress as jest.Mock).mockImplementation(async () => {
            steps.push('mark');
            return [1];
        });
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. First task', status: 'pending', completionSignalPath: 'signal-1' }
            ]);
            steps.push('launch');
            return {
                terminal,
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1',
                lineNumber: 1,
                taskDescription: '1. First task'
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(Promise.resolve(true));

        const command = commands.get('autocode.spec.implAllTasks');
        expect(command).toBeDefined();
        await command!(documentUri);
        await flushPromises();

        expect(steps).toEqual(['mark', 'launch']);
        expect(markTaskLinesInProgress).toHaveBeenCalledWith(documentUri, [1]);
        expect(taskCompletionService.registerTaskCompletion).toHaveBeenCalledWith(
            expect.anything(),
            terminal,
            {
                taskFilePath: documentUri.fsPath,
                lineNumber: 1,
                taskDescription: '1. First task'
            },
            'signal-1',
            'run-1'
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);
    });

    test('reconciles existing completion signals before launching the next auto task', async () => {
        const terminal = vscode.window.createTerminal('all');
        const steps: string[] = [];
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValueOnce({
            lineCount: 4,
            lineAt: jest.fn((lineNumber: number) => ({
                text: lineNumber === 3 ? '- [-] 2. Next task' : '# Tasks'
            }))
        });
        taskCompletionService.reconcileTaskCompletionSignals.mockImplementation(async () => {
            steps.push('reconcile');
            return { detected: 1, verified: 1 };
        });
        (markTaskLinesInProgress as jest.Mock).mockImplementation(async () => {
            steps.push('mark');
            return [3];
        });
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 3, taskDescription: '2. Next task', status: 'pending', completionSignalPath: 'signal-2' }
            ]);
            steps.push('launch');
            return {
                terminal,
                completionSignalPath: 'signal-2',
                completionSignalToken: 'run-2',
                lineNumber: 3,
                taskDescription: '2. Next task'
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(Promise.resolve(false));

        const command = commands.get('autocode.spec.implAllTasks');
        expect(command).toBeDefined();
        await command!(documentUri);

        expect(steps).toEqual(['reconcile', 'mark', 'launch']);
        expect(taskCompletionService.reconcileTaskCompletionSignals).toHaveBeenCalledWith(documentUri.fsPath, { lineNumbers: [3] });
        expect(specManager.implAllTasks).toHaveBeenCalledWith(documentUri.fsPath, expect.anything());
    });

    test('uses single-task continuation when a run also carries legacy batch signal fields', async () => {
        const terminal = vscode.window.createTerminal('all');
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. First task', status: 'pending', completionSignalPath: 'signal-1' }
            ]);
            return {
                terminal,
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1',
                completionSignalPaths: ['signal-1'],
                lineNumber: 1,
                taskDescription: '1. First task'
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(Promise.resolve(true));

        const command = commands.get('autocode.spec.implAllTasks');
        expect(command).toBeDefined();
        await command!(documentUri);
        await flushPromises();

        expect(taskCompletionService.registerTaskCompletion).toHaveBeenCalledWith(
            expect.anything(),
            terminal,
            {
                taskFilePath: documentUri.fsPath,
                lineNumber: 1,
                taskDescription: '1. First task'
            },
            'signal-1',
            'run-1'
        );
        expect(taskCompletionService.registerTaskCompletionSignals).not.toHaveBeenCalled();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);
    });

    test('continues the auto queue after legacy batch signal verification succeeds', async () => {
        const terminal = vscode.window.createTerminal('all');
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. First task', status: 'pending', completionSignalPath: 'signal-1' }
            ]);
            return {
                terminal,
                completionSignalPaths: ['signal-1']
            };
        });
        taskCompletionService.registerTaskCompletionSignals.mockReturnValue(Promise.resolve(true));

        const command = commands.get('autocode.spec.implAllTasks');
        expect(command).toBeDefined();
        await command!(documentUri);
        await flushPromises();

        expect(taskCompletionService.registerTaskCompletionSignals).toHaveBeenCalledWith(
            expect.anything(),
            terminal,
            documentUri.fsPath,
            ['signal-1']
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);
    });

    test('returns the current auto-queued task to pending when verification fails', async () => {
        const terminal = vscode.window.createTerminal('all');
        (markTaskLinesInProgress as jest.Mock).mockResolvedValue([1]);
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. Blocked task', status: 'pending', completionSignalPath: 'signal-1' }
            ]);
            return {
                terminal,
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1',
                lineNumber: 1,
                taskDescription: '1. Blocked task'
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(Promise.resolve(false));

        const command = commands.get('autocode.spec.implAllTasks');
        expect(command).toBeDefined();
        await command!(documentUri);
        await flushPromises();

        expect(markTaskLinesPending).toHaveBeenCalledWith(documentUri, [1]);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Auto task queue paused'));
    });

    test('continues a paused auto queue when the current task is manually marked done', async () => {
        const terminal = vscode.window.createTerminal('all');
        (markTaskLinesInProgress as jest.Mock).mockResolvedValue([1]);
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. Blocked task', status: 'pending', completionSignalPath: 'signal-1' }
            ]);
            return {
                terminal,
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1',
                lineNumber: 1,
                taskDescription: '1. Blocked task'
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(Promise.resolve(false));

        const startAllTasks = commands.get('autocode.spec.implAllTasks');
        expect(startAllTasks).toBeDefined();
        await startAllTasks!(documentUri);
        await flushPromises();

        expect(markTaskLinesPending).toHaveBeenCalledWith(documentUri, [1]);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);

        (updateTaskLineStatus as jest.Mock).mockResolvedValue({
            task: { status: 'completed', description: '1. Blocked task' },
            parentTasks: [],
            changedLineNumbers: [1]
        });

        const markDone = commands.get('autocode.spec.markTaskDone');
        expect(markDone).toBeDefined();
        await markDone!(documentUri, 1);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);
    });

    test('resumes a paused auto queue from the persisted queue command', async () => {
        const terminal = vscode.window.createTerminal('all');
        (markTaskLinesInProgress as jest.Mock).mockResolvedValue([1]);
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. Blocked task', status: 'pending', completionSignalPath: 'signal-1' }
            ]);
            return {
                terminal,
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1',
                lineNumber: 1,
                taskDescription: '1. Blocked task'
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(Promise.resolve(false));
        taskCompletionService.reconcileTaskCompletionSignals.mockResolvedValue({ detected: 0, verified: 0 });

        const startAllTasks = commands.get('autocode.spec.implAllTasks');
        expect(startAllTasks).toBeDefined();
        await startAllTasks!(documentUri);
        await flushPromises();

        const resumeQueue = commands.get('autocode.spec.resumeTaskQueue');
        expect(resumeQueue).toBeDefined();
        await resumeQueue!(documentUri);

        expect(taskCompletionService.reconcileTaskCompletionSignals).toHaveBeenCalledWith(documentUri.fsPath, { lineNumbers: [1] });
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);
    });

    test('does not resume a waiting auto queue until queued completion signals verify', async () => {
        const terminal = vscode.window.createTerminal('all');
        (markTaskLinesInProgress as jest.Mock).mockResolvedValue([1]);
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. Waiting task', status: 'pending', completionSignalPath: 'signal-1' }
            ]);
            return {
                terminal,
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1',
                lineNumber: 1,
                taskDescription: '1. Waiting task'
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(new Promise<boolean>(() => undefined));
        taskCompletionService.reconcileTaskCompletionSignals.mockResolvedValue({ detected: 0, verified: 0 });

        const startAllTasks = commands.get('autocode.spec.implAllTasks');
        expect(startAllTasks).toBeDefined();
        await startAllTasks!(documentUri);

        const resumeQueue = commands.get('autocode.spec.resumeTaskQueue');
        expect(resumeQueue).toBeDefined();
        await resumeQueue!(documentUri);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('still waiting'));

        taskCompletionService.reconcileTaskCompletionSignals.mockResolvedValue({ detected: 1, verified: 1 });
        await resumeQueue!(documentUri);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);
    });

    test('does not continue the auto queue twice when a verified task is later marked done manually', async () => {
        const terminal = vscode.window.createTerminal('all');
        (markTaskLinesInProgress as jest.Mock).mockResolvedValue([1]);
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. Finished task', status: 'pending', completionSignalPath: 'signal-1' }
            ]);
            return {
                terminal,
                completionSignalPath: 'signal-1',
                completionSignalToken: 'run-1',
                lineNumber: 1,
                taskDescription: '1. Finished task'
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(Promise.resolve(true));

        const startAllTasks = commands.get('autocode.spec.implAllTasks');
        expect(startAllTasks).toBeDefined();
        await startAllTasks!(documentUri);
        await flushPromises();

        expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('autocode.spec.implAllTasks', documentUri);

        (updateTaskLineStatus as jest.Mock).mockResolvedValue({
            task: { status: 'completed', description: '1. Finished task' },
            parentTasks: [],
            changedLineNumbers: [1]
        });

        const markDone = commands.get('autocode.spec.markTaskDone');
        expect(markDone).toBeDefined();
        await markDone!(documentUri, 1);

        expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    });

    test('rolls a single pending task back when starting the task terminal fails', async () => {
        (updateTaskLineStatus as jest.Mock).mockResolvedValue({
            task: { status: 'pending', description: '1. Failing task' },
            parentTasks: [],
            changedLineNumbers: [0]
        });
        specManager.implTask.mockRejectedValue(new Error('spawn failed'));

        const command = commands.get('autocode.spec.implTask');
        expect(command).toBeDefined();
        await command!(documentUri, 0, '1. Failing task');

        expect(markTaskLinesPending).toHaveBeenCalledWith(documentUri, [0]);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to start task'));
    });

    test('starts the next parallel batch after every task in the current batch verifies', async () => {
        const terminalA = vscode.window.createTerminal('a');
        const terminalB = vscode.window.createTerminal('b');
        (markTaskLinesInProgress as jest.Mock).mockResolvedValue([1, 4]);
        specManager.implAllTasksParallel.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. First task', status: 'pending', completionSignalPath: 'signal-1' },
                { lineNumber: 4, taskDescription: '2. Second task', status: 'pending', completionSignalPath: 'signal-2' }
            ]);
            return {
                parallelRuns: [
                    { terminal: terminalA, taskFilePath: documentUri.fsPath, lineNumber: 1, taskDescription: '1. First task', completionSignalPath: 'signal-1', completionSignalToken: 'run-1' },
                    { terminal: terminalB, taskFilePath: documentUri.fsPath, lineNumber: 4, taskDescription: '2. Second task', completionSignalPath: 'signal-2', completionSignalToken: 'run-2' }
                ],
                failedLineNumbers: []
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(Promise.resolve(true));

        const command = commands.get('autocode.spec.implAllTasksParallel');
        expect(command).toBeDefined();
        await command!(documentUri);
        await flushPromises();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('autocode.spec.implAllTasksParallel', documentUri);
    });

    test('returns failed parallel tasks to pending and does not continue the batch', async () => {
        const terminalA = vscode.window.createTerminal('a');
        const terminalB = vscode.window.createTerminal('b');
        (markTaskLinesInProgress as jest.Mock).mockResolvedValue([1, 4]);
        specManager.implAllTasksParallel.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. First task', status: 'pending', completionSignalPath: 'signal-1' },
                { lineNumber: 4, taskDescription: '2. Second task', status: 'pending', completionSignalPath: 'signal-2' }
            ]);
            return {
                parallelRuns: [
                    { terminal: terminalA, taskFilePath: documentUri.fsPath, lineNumber: 1, taskDescription: '1. First task', completionSignalPath: 'signal-1', completionSignalToken: 'run-1' },
                    { terminal: terminalB, taskFilePath: documentUri.fsPath, lineNumber: 4, taskDescription: '2. Second task', completionSignalPath: 'signal-2', completionSignalToken: 'run-2' }
                ],
                failedLineNumbers: []
            };
        });
        taskCompletionService.registerTaskCompletion
            .mockReturnValueOnce(Promise.resolve(true))
            .mockReturnValueOnce(Promise.resolve(false));

        const command = commands.get('autocode.spec.implAllTasksParallel');
        expect(command).toBeDefined();
        await command!(documentUri);
        await flushPromises();

        expect(markTaskLinesPending).toHaveBeenCalledWith(documentUri, [4]);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('autocode.spec.implAllTasksParallel', documentUri);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('parallel task(s) were not verified'));
    });

    test('pauses parallel queue when automatic verification is disabled for every launched task', async () => {
        const terminalA = vscode.window.createTerminal('a');
        const terminalB = vscode.window.createTerminal('b');
        (markTaskLinesInProgress as jest.Mock).mockResolvedValue([1, 4]);
        specManager.implAllTasksParallel.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. First task', status: 'pending', completionSignalPath: 'signal-1' },
                { lineNumber: 4, taskDescription: '2. Second task', status: 'pending', completionSignalPath: 'signal-2' }
            ]);
            return {
                parallelRuns: [
                    { terminal: terminalA, taskFilePath: documentUri.fsPath, lineNumber: 1, taskDescription: '1. First task', completionSignalPath: 'signal-1', completionSignalToken: 'run-1' },
                    { terminal: terminalB, taskFilePath: documentUri.fsPath, lineNumber: 4, taskDescription: '2. Second task', completionSignalPath: 'signal-2', completionSignalToken: 'run-2' }
                ],
                failedLineNumbers: []
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(undefined);

        const command = commands.get('autocode.spec.implAllTasksParallel');
        expect(command).toBeDefined();
        await command!(documentUri);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('automatic parallel task verification is disabled'));
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('autocode.spec.implAllTasksParallel', documentUri);
    });

    async function flushPromises(): Promise<void> {
        for (let index = 0; index < 8; index++) {
            await Promise.resolve();
        }
    }
});
