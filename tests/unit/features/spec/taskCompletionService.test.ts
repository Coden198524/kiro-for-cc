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
});
