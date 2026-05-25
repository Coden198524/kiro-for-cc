import * as vscode from 'vscode';
import { SpecManager } from '../../../../src/features/spec/specManager';
import { AgentRuntime, AgentProviderConfig } from '../../../../src/runtime/agentRuntime';
import { ConfigManager } from '../../../../src/utils/configManager';
import { PromptLoader } from '../../../../src/services/promptLoader';

jest.mock('vscode');

describe('SpecManager', () => {
    const provider: AgentProviderConfig = {
        id: 'claude',
        displayName: 'Claude Code',
        command: 'claude',
        capabilities: {
            permissions: true,
            expertAgents: true,
            claudeAgents: true,
            claudeHooks: true,
            claudeMcp: true,
            extensionMcp: true,
            headless: true,
            interactiveSpecWorkflow: true
        }
    };
    const codexProvider: AgentProviderConfig = {
        ...provider,
        id: 'codex',
        displayName: 'Codex',
        command: 'codex',
        capabilities: {
            ...provider.capabilities,
            permissions: false,
            claudeAgents: false,
            claudeHooks: false,
            claudeMcp: false
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (ConfigManager as any).instance = undefined;
        PromptLoader.getInstance().initialize();
        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: '/mock/workspace', path: '/mock/workspace', scheme: 'file' },
            name: 'mock-workspace',
            index: 0
        }];
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            const normalizedPath = uri.fsPath.replace(/\\/g, '/');
            if (normalizedPath.endsWith('/.autocode/settings/autocode-settings.json') ||
                normalizedPath.endsWith('/.claude/settings/kfc-settings.json')) {
                throw new Error('missing settings');
            }

            if (normalizedPath.endsWith('/tasks.md')) {
                return Buffer.from('# 实现计划\n\n- [ ] 1. 实现中文任务\n  - 读取中文需求并保持中文输出');
            }

            if (normalizedPath.endsWith('/requirements.md')) {
                return Buffer.from('# 需求文档\n\n## 介绍\n\n这个功能需要支持中文任务实现流程。');
            }

            if (normalizedPath.endsWith('/design.md')) {
                return Buffer.from('# 设计文档\n\n系统应沿用中文上下文。');
            }

            throw new Error(`Unexpected read: ${uri.fsPath}`);
        });
        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.delete as jest.Mock).mockRejectedValue(new Error('missing signal'));
    });

    test('uses the spec document language for task implementation prompts', async () => {
        let capturedPrompt = '';
        const runtime: AgentRuntime = {
            provider,
            refreshProvider: jest.fn(),
            invokeInteractive: jest.fn(async (request) => {
                capturedPrompt = request.prompt;
                return vscode.window.createTerminal('mock');
            }),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        const run = await specManager.implTask('/mock/workspace/.autocode/specs/demo/tasks.md', '1. 实现中文任务', false, 0);

        expect(capturedPrompt).toContain('Language Preference: Chinese (中文)');
        expect(capturedPrompt).toContain('Use Chinese (中文) for all conversational responses');
        expect(capturedPrompt).toContain('从当前 spec 上下文开始执行这个任务');
        expect(capturedPrompt).toContain('Completion Signal Path:');
        expect(capturedPrompt).toContain('task-completion-1.json');
        expect(capturedPrompt).toContain('"status": "ready_for_verification"');
        expect(run?.completionSignalPath?.replace(/\\/g, '/')).toBe('/mock/workspace/.autocode/specs/demo/.autocode/task-completion-1.json');
    });

    test('adds Codex quality and speed guidance to task implementation prompts', async () => {
        let capturedPrompt = '';
        const runtime = createRuntime(codexProvider, prompt => {
            capturedPrompt = prompt;
        });
        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        await specManager.implTask('/mock/workspace/.autocode/specs/demo/tasks.md', '1. 实现中文任务', false, 0);

        expect(capturedPrompt).toContain('Provider execution guidance:');
        expect(capturedPrompt).toContain('Codex quality and speed rules:');
        expect(capturedPrompt).toContain('Run the narrowest useful verification command');
        expect(capturedPrompt).toContain('Write the completion signal only after implementation and verification are complete.');
    });

    test('verifies Codex project agents before creating a spec with agents', async () => {
        let capturedPrompt = '';
        const runtime = createRuntime(codexProvider, prompt => {
            capturedPrompt = prompt;
        });
        const agentManager = {
            ensureCodexAgentsReady: jest.fn().mockResolvedValue({
                ready: true,
                agentsPath: '/mock/workspace/.codex/agents',
                configPath: '/mock/workspace/.codex/config.toml',
                existingAgents: ['spec-requirements'],
                createdAgents: ['spec-design'],
                missingAgents: [],
                errors: []
            })
        };
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('Build a reporting dashboard');

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel, undefined, agentManager as any);

        await specManager.createWithAgents();

        expect(agentManager.ensureCodexAgentsReady).toHaveBeenCalledTimes(1);
        expect(runtime.invokeInteractive).toHaveBeenCalledWith(expect.objectContaining({
            title: 'AutoCode - Creating Spec (Agents)',
            agentType: 'spec_with_agents'
        }));
        expect(capturedPrompt).toContain('Agent directory: /mock/workspace/.codex/agents');
        expect(capturedPrompt).toContain('Agent readiness: Codex project expert agents were verified before launch.');
        expect(capturedPrompt).toContain('Created agents this run: spec-design.');
        expect(capturedPrompt).toContain('native delegation or TOML instruction emulation');
    });

    test('does not create a Codex spec with agents when project agents are not ready', async () => {
        const runtime = createRuntime(codexProvider, () => undefined);
        const agentManager = {
            ensureCodexAgentsReady: jest.fn().mockResolvedValue({
                ready: false,
                agentsPath: '/mock/workspace/.codex/agents',
                configPath: '/mock/workspace/.codex/config.toml',
                existingAgents: [],
                createdAgents: [],
                missingAgents: ['spec-requirements'],
                errors: ['missing source']
            })
        };
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('Build a reporting dashboard');

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel, undefined, agentManager as any);

        await specManager.createWithAgents();

        expect(agentManager.ensureCodexAgentsReady).toHaveBeenCalledTimes(1);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Codex expert agents are not ready'));
        expect(runtime.invokeInteractive).not.toHaveBeenCalled();
    });

    test('start all tasks launches only the next runnable task', async () => {
        let capturedPrompt = '';
        const runtime: AgentRuntime = {
            provider,
            refreshProvider: jest.fn(),
            invokeInteractive: jest.fn(async (request) => {
                capturedPrompt = request.prompt;
                return vscode.window.createTerminal('mock');
            }),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. First task',
            '- [x] 2. Done task',
            '- [-] 3. Resume task'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        const run = await specManager.implAllTasks('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(runtime.invokeInteractive).toHaveBeenCalledWith(expect.objectContaining({
            title: 'AutoCode - Task 2',
            reuseTerminal: true,
            approvalPolicy: 'never'
        }));
        expect(capturedPrompt).toContain('Task Description: 1. First task');
        expect(capturedPrompt).not.toContain('3. Resume task');
        expect(capturedPrompt).not.toContain('2. Done task');
        expect(run?.completionSignalPath?.replace(/\\/g, '/')).toBe('/mock/workspace/.autocode/specs/demo/.autocode/task-completion-2.json');
        expect(run?.lineNumber).toBe(1);
        expect(run?.taskDescription).toBe('1. First task');
    });

    test('start all tasks skips parent tasks when numbered child tasks exist', async () => {
        let capturedPrompt = '';
        const runtime: AgentRuntime = {
            provider,
            refreshProvider: jest.fn(),
            invokeInteractive: jest.fn(async (request) => {
                capturedPrompt = request.prompt;
                return vscode.window.createTerminal('mock');
            }),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. Parent task',
            '- [ ] 1.1 First child',
            '- [ ] 1.2 Second child',
            '- [ ] 2. Standalone task'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        const run = await specManager.implAllTasks('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(capturedPrompt).not.toContain('1. Parent task');
        expect(capturedPrompt).toContain('Task Description: 1.1 First child');
        expect(capturedPrompt).not.toContain('1.2 Second child');
        expect(capturedPrompt).not.toContain('2. Standalone task');
        expect(run?.completionSignalPath?.replace(/\\/g, '/')).toBe('/mock/workspace/.autocode/specs/demo/.autocode/task-completion-3.json');
    });

    test('adds focused Codex guidance to auto-queued task prompts', async () => {
        let capturedPrompt = '';
        const runtime = createRuntime(codexProvider, prompt => {
            capturedPrompt = prompt;
        });
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. First task',
            '- [ ] 2. Second task'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        await specManager.implAllTasks('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(capturedPrompt).toContain('Codex quality and speed rules:');
        expect(capturedPrompt).toContain('Run the narrowest useful verification command');
        expect(capturedPrompt).toContain('Write the completion signal only after implementation and verification are complete.');
        expect(capturedPrompt).not.toContain('Reuse context across the listed tasks');
    });

    test('orders sequential all-task execution by dependency metadata when file order is not topological', async () => {
        let capturedPrompt = '';
        const runtime = createRuntime(provider, prompt => {
            capturedPrompt = prompt;
        });
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 2. Implement dependent feature',
            '  - _Files: src/feature.ts_',
            '  - _Depends on: 1_',
            '- [ ] 1. Setup core scaffolding',
            '  - _Files: src/setup.ts_',
            '  - _Depends on: none_'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        const run = await specManager.implAllTasks('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(capturedPrompt).toContain('Task Description: 1. Setup core scaffolding');
        expect(capturedPrompt).not.toContain('2. Implement dependent feature');
        expect(run?.completionSignalPath?.replace(/\\/g, '/')).toBe('/mock/workspace/.autocode/specs/demo/.autocode/task-completion-5.json');
    });

    test('runs the batch pre-launch hook before opening the implementation terminal', async () => {
        const steps: string[] = [];
        const runtime: AgentRuntime = {
            provider,
            refreshProvider: jest.fn(),
            invokeInteractive: jest.fn(async () => {
                steps.push('launch');
                return vscode.window.createTerminal('mock');
            }),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. First task',
            '- [ ] 2. Second task'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        await specManager.implAllTasks('/mock/workspace/.autocode/specs/demo/tasks.md', {
            beforeLaunchTasks: async () => {
                steps.push('mark');
            }
        });

        expect(steps).toEqual(['mark', 'launch']);
    });

    test('starts independent tasks in separate terminals for parallel all-task execution', async () => {
        const capturedRequests: Array<{ prompt: string; title?: string; reuseTerminal?: boolean; approvalPolicy?: string }> = [];
        const runtime: AgentRuntime = {
            provider,
            refreshProvider: jest.fn(),
            invokeInteractive: jest.fn(async (request) => {
                capturedRequests.push({
                    prompt: request.prompt,
                    title: request.title,
                    reuseTerminal: request.reuseTerminal,
                    approvalPolicy: request.approvalPolicy
                });
                return vscode.window.createTerminal('mock');
            }),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. Renderer task',
            '  - Modify `src/render/renderer.ts`',
            '- [ ] 2. Parser task',
            '  - Modify `src/parser/parser.ts`'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        const run = await specManager.implAllTasksParallel('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(runtime.invokeInteractive).toHaveBeenCalledTimes(2);
        expect(capturedRequests.map(request => request.reuseTerminal)).toEqual([false, false]);
        expect(capturedRequests.map(request => request.approvalPolicy)).toEqual(['never', 'never']);
        expect(capturedRequests.map(request => request.title)).toEqual(['AutoCode - Task 2', 'AutoCode - Task 4']);
        expect(capturedRequests[0].prompt).toContain('Parallel execution safety rules:');
        expect(capturedRequests[0].prompt).toContain('src/render/renderer.ts');
        expect(capturedRequests[1].prompt).toContain('src/parser/parser.ts');
        expect(run?.parallelRuns?.map(item => item.lineNumber)).toEqual([1, 3]);
        expect(run?.parallelRuns?.map(item => item.completionSignalPath.replace(/\\/g, '/'))).toEqual([
            '/mock/workspace/.autocode/specs/demo/.autocode/task-completion-2.json',
            '/mock/workspace/.autocode/specs/demo/.autocode/task-completion-4.json'
        ]);
    });

    test('uses task dependency metadata as a DAG and starts only the ready parallel batch', async () => {
        const capturedRequests: Array<{ prompt: string; title?: string; reuseTerminal?: boolean; approvalPolicy?: string }> = [];
        const runtime: AgentRuntime = {
            provider,
            refreshProvider: jest.fn(),
            invokeInteractive: jest.fn(async (request) => {
                capturedRequests.push({
                    prompt: request.prompt,
                    title: request.title,
                    reuseTerminal: request.reuseTerminal,
                    approvalPolicy: request.approvalPolicy
                });
                return vscode.window.createTerminal('mock');
            }),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. Setup core scaffolding',
            '  - _Files: src/setup.ts_',
            '  - _Depends on: none_',
            '- [ ] 2. Implement dependent feature',
            '  - _Files: src/feature.ts_',
            '  - _Depends on: 1_',
            '- [ ] 3. Implement independent adapter',
            '  - _Files: src/adapter.ts_',
            '  - _Depends on: none_'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        const run = await specManager.implAllTasksParallel('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(runtime.invokeInteractive).toHaveBeenCalledTimes(2);
        expect(capturedRequests.map(request => request.approvalPolicy)).toEqual(['never', 'never']);
        expect(capturedRequests.map(request => request.title)).toEqual(['AutoCode - Task 2', 'AutoCode - Task 8']);
        expect(capturedRequests[0].prompt).toContain('1. Setup core scaffolding');
        expect(capturedRequests[1].prompt).toContain('3. Implement independent adapter');
        expect(capturedRequests.map(request => request.prompt).join('\n')).not.toContain('2. Implement dependent feature');
        expect(run?.parallelRuns?.map(item => item.lineNumber)).toEqual([1, 7]);
    });

    test('accepts localized dependency metadata without treating it as cross-cutting risk', async () => {
        const runtime = createRuntime(provider, () => undefined);
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. 实现核心类型',
            '  - _Files: src/core/types.ts_',
            '  - _依赖: 无_',
            '- [ ] 2. 实现适配器',
            '  - _Files: src/adapters/main.ts_',
            '  - _依赖: 无_'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        const run = await specManager.implAllTasksParallel('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(vscode.window.showWarningMessage).not.toHaveBeenCalledWith(expect.stringContaining('cross-cutting'));
        expect(runtime.invokeInteractive).toHaveBeenCalledTimes(2);
        expect(run?.parallelRuns?.map(item => item.lineNumber)).toEqual([1, 4]);
    });

    test('falls back to sequential all-task execution when dependency metadata is cyclic', async () => {
        const runtime = createRuntime(provider, () => undefined);
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. First task',
            '  - _Files: src/first.ts_',
            '  - _Depends on: 2_',
            '- [ ] 2. Second task',
            '  - _Files: src/second.ts_',
            '  - _Depends on: 1_'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        await specManager.implAllTasksParallel('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('cycle'));
        expect(runtime.invokeInteractive).toHaveBeenCalledTimes(1);
        expect(runtime.invokeInteractive).toHaveBeenCalledWith(expect.objectContaining({
            title: 'AutoCode - Task 2',
            reuseTerminal: true,
            approvalPolicy: 'never'
        }));
    });

    test('falls back to sequential all-task execution when parallel file scopes overlap', async () => {
        const runtime = createRuntime(provider, () => undefined);
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. Renderer task',
            '  - Modify `src/render/renderer.ts`',
            '- [ ] 2. Renderer tests',
            '  - Modify `src/render/renderer.ts`'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        const run = await specManager.implAllTasksParallel('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('fell back to sequential mode'));
        expect(runtime.invokeInteractive).toHaveBeenCalledTimes(1);
        expect(runtime.invokeInteractive).toHaveBeenCalledWith(expect.objectContaining({
            title: 'AutoCode - Task 2',
            reuseTerminal: true,
            approvalPolicy: 'never'
        }));
        expect(run?.completionSignalPath?.replace(/\\/g, '/')).toBe('/mock/workspace/.autocode/specs/demo/.autocode/task-completion-2.json');
    });

    test('falls back to sequential all-task execution when a task has no explicit file scope', async () => {
        const runtime = createRuntime(provider, () => undefined);
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. Improve validation behavior',
            '- [ ] 2. Parser task',
            '  - Modify `src/parser/parser.ts`'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        await specManager.implAllTasksParallel('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('no explicit file scope'));
        expect(runtime.invokeInteractive).toHaveBeenCalledTimes(1);
        expect(runtime.invokeInteractive).toHaveBeenCalledWith(expect.objectContaining({
            title: 'AutoCode - Task 2',
            reuseTerminal: true,
            approvalPolicy: 'never'
        }));
    });

    test('falls back to sequential execution when a task depends on an incomplete non-runnable parent task', async () => {
        const runtime = createRuntime(provider, () => undefined);
        const document = createTaskDocument([
            '# Implementation Plan',
            '- [ ] 1. Parent task',
            '- [ ] 1.1 First child',
            '  - _Files: src/first.ts_',
            '  - _Depends on: none_',
            '- [ ] 1.2 Second child',
            '  - _Files: src/second.ts_',
            '  - _Depends on: 1_'
        ]);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        await specManager.implAllTasksParallel('/mock/workspace/.autocode/specs/demo/tasks.md');

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('non-runnable incomplete task 1'));
        expect(runtime.invokeInteractive).toHaveBeenCalledTimes(1);
        expect(runtime.invokeInteractive).toHaveBeenCalledWith(expect.objectContaining({
            title: 'AutoCode - Task 3',
            reuseTerminal: true,
            approvalPolicy: 'never'
        }));
    });

    function createRuntime(providerConfig: AgentProviderConfig, onPrompt: (prompt: string) => void): AgentRuntime {
        return {
            provider: providerConfig,
            refreshProvider: jest.fn(),
            invokeInteractive: jest.fn(async (request) => {
                onPrompt(request.prompt);
                return vscode.window.createTerminal('mock');
            }),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };
    }

    function createTaskDocument(lines: string[]): vscode.TextDocument {
        return {
            lineCount: lines.length,
            lineAt: (lineNumber: number) => ({ text: lines[lineNumber] })
        } as any;
    }
});
