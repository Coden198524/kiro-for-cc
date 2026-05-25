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

    test('marks all selected tasks in progress before launching the batch terminal', async () => {
        const terminal = vscode.window.createTerminal('all');
        const steps: string[] = [];
        (markTaskLinesInProgress as jest.Mock).mockImplementation(async () => {
            steps.push('mark');
            return [1, 3];
        });
        specManager.implAllTasks.mockImplementation(async (_taskFilePath: string, options: any) => {
            await options.beforeLaunchTasks([
                { lineNumber: 1, taskDescription: '1. First task', status: 'pending', completionSignalPath: 'signal-1' },
                { lineNumber: 3, taskDescription: '2. Second task', status: 'pending', completionSignalPath: 'signal-2' }
            ]);
            steps.push('launch');
            return { terminal, completionSignalPaths: ['signal-1', 'signal-2'] };
        });

        const command = commands.get('autocode.spec.implAllTasks');
        expect(command).toBeDefined();
        await command!(documentUri);

        expect(steps).toEqual(['mark', 'launch']);
        expect(markTaskLinesInProgress).toHaveBeenCalledWith(documentUri, [1, 3]);
        expect(taskCompletionService.registerTaskCompletionSignals).toHaveBeenCalledWith(
            expect.anything(),
            terminal,
            documentUri.fsPath,
            ['signal-1', 'signal-2']
        );
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
                    { terminal: terminalA, taskFilePath: documentUri.fsPath, lineNumber: 1, taskDescription: '1. First task', completionSignalPath: 'signal-1' },
                    { terminal: terminalB, taskFilePath: documentUri.fsPath, lineNumber: 4, taskDescription: '2. Second task', completionSignalPath: 'signal-2' }
                ],
                failedLineNumbers: []
            };
        });
        taskCompletionService.registerTaskCompletion.mockReturnValue(Promise.resolve(true));

        const command = commands.get('autocode.spec.implAllTasksParallel');
        expect(command).toBeDefined();
        await command!(documentUri);
        await Promise.resolve();
        await Promise.resolve();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('autocode.spec.implAllTasksParallel', documentUri);
    });
});
