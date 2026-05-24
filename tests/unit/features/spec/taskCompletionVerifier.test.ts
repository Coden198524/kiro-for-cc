import * as vscode from 'vscode';
import { TaskCompletionVerifier } from '../../../../src/features/spec/taskCompletionVerifier';
import { AgentRuntime } from '../../../../src/runtime/agentRuntime';
import { TaskSessionManager } from '../../../../src/features/spec/taskSessionManager';

describe('TaskCompletionVerifier', () => {
    const taskFilePath = '/mock/workspace/.autocode/specs/demo/tasks.md';
    let runtime: AgentRuntime;
    let taskSessionManager: TaskSessionManager;
    let verifier: TaskCompletionVerifier;
    let documentLines: string[];
    let saved = false;

    beforeEach(() => {
        jest.clearAllMocks();
        documentLines = ['- [-] 1. Implement feature'];
        saved = false;

        (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(async () => ({
            lineCount: documentLines.length,
            lineAt: jest.fn((lineNumber: number) => ({ text: documentLines[lineNumber] })),
            save: jest.fn(async () => {
                saved = true;
                return true;
            })
        }));
        (vscode.workspace.applyEdit as jest.Mock).mockImplementation(async (edit: any) => {
            for (const entry of edit.entries) {
                documentLines[entry.range.start.line] = entry.newText;
            }
            return true;
        });
        (vscode.workspace as any).getConfiguration = jest.fn(() => ({
            inspect: jest.fn((section: string) => {
                if (section === 'spec.autoMarkTaskDone') {
                    return { workspaceValue: true };
                }
                if (section === 'spec.autoMarkTaskDoneMinConfidence') {
                    return { workspaceValue: 0.8 };
                }
                return undefined;
            }),
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue)
        }));

        runtime = {
            provider: {
                id: 'codex',
                displayName: 'Codex',
                command: 'codex',
                capabilities: {
                    permissions: false,
                    expertAgents: true,
                    claudeAgents: false,
                    claudeHooks: false,
                    claudeMcp: false,
                    extensionMcp: true,
                    headless: true,
                    interactiveSpecWorkflow: true
                }
            },
            invokeInteractive: jest.fn(),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };
        taskSessionManager = {
            markCompleted: jest.fn()
        } as any;
        verifier = new TaskCompletionVerifier(runtime, taskSessionManager, { appendLine: jest.fn() } as any);
    });

    test('marks task done when model verification confirms completion', async () => {
        (runtime.invokeHeadless as jest.Mock).mockResolvedValue({
            exitCode: 0,
            output: '{"completed":true,"confidence":0.92,"summary":"done","evidence":["tests pass"],"missing":[]}'
        });

        const result = await verifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber: 0,
            taskDescription: '1. Implement feature'
        });

        expect(result).toBe(true);
        expect(documentLines[0]).toBe('- [x] 1. Implement feature');
        expect(saved).toBe(true);
        expect(taskSessionManager.markCompleted).toHaveBeenCalledWith(taskFilePath, 0, '1. Implement feature');
    });

    test('resolves moved task line by description before marking done', async () => {
        documentLines = [
            '- [-] 1. First task',
            '  - Details for first task',
            '- [-] 2. Second task'
        ];
        (runtime.invokeHeadless as jest.Mock).mockResolvedValue({
            exitCode: 0,
            output: '{"completed":true,"confidence":0.92,"summary":"done","evidence":["tests pass"],"missing":[]}'
        });

        const result = await verifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber: 0,
            taskDescription: '2. Second task'
        });

        expect(result).toBe(true);
        expect(documentLines).toEqual([
            '- [-] 1. First task',
            '  - Details for first task',
            '- [x] 2. Second task'
        ]);
        expect(taskSessionManager.markCompleted).toHaveBeenCalledWith(taskFilePath, 2, '2. Second task');
    });

    test('does not mark done when model confidence is too low', async () => {
        (runtime.invokeHeadless as jest.Mock).mockResolvedValue({
            exitCode: 0,
            output: '{"completed":true,"confidence":0.5,"summary":"uncertain","evidence":[],"missing":["tests"]}'
        });

        const result = await verifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber: 0,
            taskDescription: '1. Implement feature'
        });

        expect(result).toBe(false);
        expect(documentLines[0]).toBe('- [-] 1. Implement feature');
        expect(taskSessionManager.markCompleted).not.toHaveBeenCalled();
    });

    test('marks parent task done when the verified child completes all siblings', async () => {
        documentLines = [
            '- [-] 1. Parent task',
            '- [x] 1.1 First child',
            '- [-] 1.2 Second child'
        ];
        (runtime.invokeHeadless as jest.Mock).mockResolvedValue({
            exitCode: 0,
            output: '{"completed":true,"confidence":0.91,"summary":"done","evidence":["tests pass"],"missing":[]}'
        });

        const result = await verifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '1.2 Second child'
        });

        expect(result).toBe(true);
        expect(documentLines).toEqual([
            '- [x] 1. Parent task',
            '- [x] 1.1 First child',
            '- [x] 1.2 Second child'
        ]);
        expect(taskSessionManager.markCompleted).toHaveBeenCalledWith(taskFilePath, 2, '1.2 Second child');
        expect(taskSessionManager.markCompleted).toHaveBeenCalledWith(taskFilePath, 0, '1. Parent task');
    });
});
