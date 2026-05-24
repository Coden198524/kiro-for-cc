import * as vscode from 'vscode';
import { TaskCompletionVerifier } from '../../../../src/features/spec/taskCompletionVerifier';
import { AgentRuntime } from '../../../../src/runtime/agentRuntime';
import { TaskSessionManager } from '../../../../src/features/spec/taskSessionManager';

describe('TaskCompletionVerifier', () => {
    const taskFilePath = '/mock/workspace/.autocode/specs/demo/tasks.md';
    let runtime: AgentRuntime;
    let taskSessionManager: TaskSessionManager;
    let verifier: TaskCompletionVerifier;
    let documentLine = '- [-] 1. Implement feature';
    let saved = false;

    beforeEach(() => {
        jest.clearAllMocks();
        documentLine = '- [-] 1. Implement feature';
        saved = false;

        (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(async () => ({
            lineCount: 1,
            lineAt: jest.fn(() => ({ text: documentLine })),
            save: jest.fn(async () => {
                saved = true;
                return true;
            })
        }));
        (vscode.workspace.applyEdit as jest.Mock).mockImplementation(async (edit: any) => {
            documentLine = edit.entries[0].newText;
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
        expect(documentLine).toBe('- [x] 1. Implement feature');
        expect(saved).toBe(true);
        expect(taskSessionManager.markCompleted).toHaveBeenCalledWith(taskFilePath, 0, '1. Implement feature');
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
        expect(documentLine).toBe('- [-] 1. Implement feature');
        expect(taskSessionManager.markCompleted).not.toHaveBeenCalled();
    });
});
