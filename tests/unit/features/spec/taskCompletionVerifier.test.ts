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
    let verificationMode: 'fast' | 'strict';

    beforeEach(() => {
        jest.clearAllMocks();
        documentLines = ['- [-] 1. Implement feature'];
        saved = false;
        verificationMode = 'fast';

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
                if (section === 'spec.taskCompletionVerificationMode') {
                    return { workspaceValue: verificationMode };
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

    test('marks task done from completion signal in fast mode without model verification', async () => {
        const result = await verifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber: 0,
            taskDescription: '1. Implement feature'
        });

        expect(result).toBe(true);
        expect(documentLines[0]).toBe('- [x] 1. Implement feature');
        expect(saved).toBe(true);
        expect(runtime.invokeHeadless).not.toHaveBeenCalled();
        expect(taskSessionManager.markCompleted).toHaveBeenCalledWith(taskFilePath, 0, '1. Implement feature');
    });

    test('runs visible model verification before marking done in strict mode', async () => {
        verificationMode = 'strict';
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
        expect(runtime.invokeHeadless).toHaveBeenCalledWith(expect.objectContaining({
            approvalPolicy: 'never',
            visibleTerminal: true
        }));
        expect(taskSessionManager.markCompleted).toHaveBeenCalledWith(taskFilePath, 0, '1. Implement feature');
    });

    test('runs strict verification inside the provided task terminal', async () => {
        verificationMode = 'strict';
        const terminal = vscode.window.createTerminal('Task 1');
        (runtime.invokeInteractive as jest.Mock).mockResolvedValue(terminal);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(
            '{"completed":true,"confidence":0.92,"summary":"done","evidence":["tests pass"],"missing":[]}'
        ));

        const result = await verifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber: 0,
            taskDescription: '1. Implement feature'
        }, terminal);

        expect(result).toBe(true);
        expect(runtime.invokeHeadless).not.toHaveBeenCalled();
        expect(runtime.invokeInteractive).toHaveBeenCalledWith(expect.objectContaining({
            targetTerminal: terminal,
            approvalPolicy: 'never'
        }));
        const prompt = (runtime.invokeInteractive as jest.Mock).mock.calls[0][0].prompt as string;
        expect(prompt).toContain('Verification result file:');
        expect(prompt).toContain('Do not modify source files or task checkboxes.');
        expect(documentLines[0]).toBe('- [x] 1. Implement feature');
    });

    test('uses Chinese verification prompts for Chinese tasks', async () => {
        verificationMode = 'strict';
        documentLines = ['- [-] 3.3 实现配置加载启动步骤'];
        const terminal = vscode.window.createTerminal('Task 3.3');
        (runtime.invokeInteractive as jest.Mock).mockResolvedValue(terminal);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(
            '{"completed":true,"confidence":0.92,"summary":"已完成","evidence":["测试通过"],"missing":[]}'
        ));

        const result = await verifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber: 0,
            taskDescription: '3.3 实现配置加载启动步骤'
        }, terminal);

        expect(result).toBe(true);
        const prompt = (runtime.invokeInteractive as jest.Mock).mock.calls[0][0].prompt as string;
        expect(prompt).toContain('你正在验证一个 Spec 实现任务是否真正完成。');
        expect(prompt).toContain('验证结果文件：');
        expect(prompt).toContain('请在当前终端用中文简要总结验证结论');
        expect(prompt).toContain('JSON 字段名必须保持英文');
        expect(prompt).not.toContain('You are verifying whether a single spec implementation task is truly complete.');
    });

    test('verifies and marks task done when it is still pending', async () => {
        documentLines = ['- [ ] 1. Implement feature'];
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
        expect(taskSessionManager.markCompleted).toHaveBeenCalledWith(taskFilePath, 0, '1. Implement feature');
    });

    test('treats an already completed task as verified', async () => {
        documentLines = ['- [x] 1. Implement feature'];

        const result = await verifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber: 0,
            taskDescription: '1. Implement feature'
        });

        expect(result).toBe(true);
        expect(runtime.invokeHeadless).not.toHaveBeenCalled();
        expect(documentLines[0]).toBe('- [x] 1. Implement feature');
        expect(taskSessionManager.markCompleted).toHaveBeenCalledWith(taskFilePath, 0, '1. Implement feature');
    });

    test('parses verification JSON when provider output includes unrelated JSON logs', async () => {
        verificationMode = 'strict';
        (runtime.invokeHeadless as jest.Mock).mockResolvedValue({
            exitCode: 0,
            output: 'debug {"event":"started"}',
            stderr: '```json\n{"completed":true,"confidence":0.92,"summary":"done","evidence":["tests pass"],"missing":[]}\n```'
        });

        const result = await verifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber: 0,
            taskDescription: '1. Implement feature'
        });

        expect(result).toBe(true);
        expect(documentLines[0]).toBe('- [x] 1. Implement feature');
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
        verificationMode = 'strict';
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
