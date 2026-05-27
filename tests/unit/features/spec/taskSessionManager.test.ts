import * as vscode from 'vscode';
import { TaskSessionManager } from '../../../../src/features/spec/taskSessionManager';
import { AgentProviderConfig } from '../../../../src/runtime/agentRuntime';
import { ConfigManager } from '../../../../src/utils/configManager';

describe('TaskSessionManager', () => {
    const taskFilePath = '/mock/workspace/.autocode/specs/demo/tasks.md';
    let files: Map<string, Buffer>;
    let manager: TaskSessionManager;
    let providerSessionHistory: { findSession: jest.Mock };

    beforeEach(() => {
        jest.clearAllMocks();
        files = new Map();
        (ConfigManager as any).instance = undefined;
        providerSessionHistory = { findSession: jest.fn().mockResolvedValue(undefined) };

        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            const content = files.get(uri.fsPath) ?? files.get(uri.fsPath.replace(/\\/g, '/'));
            if (!content) {
                throw new Error(`missing ${uri.fsPath}`);
            }
            return content;
        });
        (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(async (uri: vscode.Uri, content: Uint8Array) => {
            files.set(uri.fsPath, Buffer.from(content));
        });
        (vscode.workspace.fs.readDirectory as jest.Mock).mockRejectedValue(new Error('missing directory'));
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('missing file'));
        (vscode.workspace.fs.delete as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            files.delete(uri.fsPath);
            files.delete(uri.fsPath.replace(/\\/g, '/'));
        });
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({ uri: vscode.Uri.file('/preview.md') });
        (vscode.window.showTextDocument as jest.Mock).mockResolvedValue(undefined);

        manager = new TaskSessionManager({ appendLine: jest.fn() } as any, providerSessionHistory as any);
    });

    test('records task invocation with prompt snapshot and provider metadata', async () => {
        const session = await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'start',
            provider: provider(),
            prompt: 'Implement the task',
            runId: 'run-2',
            terminal: { name: 'AutoCode - Implementing Task' } as any
        });

        expect(session.status).toBe('inProgress');
        expect(session.invocations).toHaveLength(1);
        expect(session.invocations[0]).toMatchObject({
            mode: 'start',
            providerName: 'Codex',
            terminalName: 'AutoCode - Implementing Task',
            runId: 'run-2'
        });

        const store = readStore();
        expect(store.sessions).toHaveLength(1);
        expect(files.get(session.invocations[0].promptSnapshotPath)?.toString()).toBe('Implement the task');
    });

    test('cleans up expired session prompt snapshots on startup', async () => {
        const outputChannel = { appendLine: jest.fn() };
        const oldPromptPath = '/mock/workspace/.autocode/specs/demo/.autocode/session-prompts/old.md';
        const freshPromptPath = '/mock/workspace/.autocode/specs/demo/.autocode/session-prompts/fresh.md';

        (vscode.workspace.fs.readDirectory as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            if (uri.fsPath.replace(/\\/g, '/') === '/mock/workspace/.autocode/specs') {
                return [['demo', vscode.FileType.Directory]];
            }

            if (uri.fsPath.replace(/\\/g, '/').endsWith('/.autocode/session-prompts')) {
                return [
                    ['old.md', vscode.FileType.File],
                    ['fresh.md', vscode.FileType.File],
                    ['nested', vscode.FileType.Directory]
                ];
            }

            throw new Error(`unexpected directory ${uri.fsPath}`);
        });
        (vscode.workspace.fs.stat as jest.Mock).mockImplementation(async (uri: vscode.Uri) => ({
            type: vscode.FileType.File,
            ctime: Date.now(),
            mtime: uri.fsPath.replace(/\\/g, '/') === oldPromptPath ? Date.now() - 8 * 24 * 60 * 60 * 1000 : Date.now(),
            size: 1
        }));

        new TaskSessionManager(outputChannel as any, providerSessionHistory as any);
        await flushPromises();

        const deletedPaths = (vscode.workspace.fs.delete as jest.Mock).mock.calls
            .map(call => call[0].fsPath.replace(/\\/g, '/'));
        expect(deletedPaths).toContain(oldPromptPath);
        expect(deletedPaths).not.toContain(freshPromptPath);
    });

    test('marks the latest matching session completed', async () => {
        await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'start',
            provider: provider(),
            prompt: 'Implement the task'
        });

        const completed = await manager.markCompleted(taskFilePath, 2, '2. Continue me');

        expect(completed?.status).toBe('completed');
        expect(completed?.completedAt).toBeTruthy();
        expect(readStore().sessions[0].status).toBe('completed');
    });

    test('shows the active provider terminal when it is still open', async () => {
        const terminal = {
            name: 'Task 2. Continue me',
            show: jest.fn()
        };

        await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'resume',
            provider: provider(),
            prompt: 'Resume the task',
            terminal: terminal as any
        });

        await manager.showSession(taskFilePath, 2, '2. Continue me');

        expect(terminal.show).toHaveBeenCalled();
        expect(vscode.window.createTerminal).not.toHaveBeenCalled();
        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    test('opens the Codex history session when the task terminal is closed', async () => {
        await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'resume',
            provider: provider(),
            prompt: 'Resume the task'
        });

        await manager.showSession(taskFilePath, 2, '2. Continue me');

        const terminal = (vscode.window.createTerminal as jest.Mock).mock.results[0].value;
        expect(vscode.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Codex Session - 2. Continue me'
        }));
        expect(terminal.show).toHaveBeenCalled();
        expect(terminal.sendText).toHaveBeenCalledWith('codex resume --last', true);
        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    test('opens a matched Codex provider session by id and stores the match', async () => {
        providerSessionHistory.findSession.mockResolvedValue({
            sessionId: '019e605d-a4f0-7080-97a3-12dbe1d3799f',
            filePath: '/mock/home/.codex/sessions/rollout.jsonl',
            score: 300,
            matchedBy: ['task description', 'completion signal path'],
            updatedAt: 1
        });

        await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'resume',
            provider: provider(),
            prompt: 'Resume the task'
        });

        await manager.showSession(taskFilePath, 2, '2. Continue me');

        const terminal = (vscode.window.createTerminal as jest.Mock).mock.results[0].value;
        expect(terminal.sendText).toHaveBeenCalledWith('codex resume 019e605d-a4f0-7080-97a3-12dbe1d3799f', true);
        expect(readStore().sessions[0].invocations[0]).toMatchObject({
            providerSessionId: '019e605d-a4f0-7080-97a3-12dbe1d3799f',
            providerSessionPath: '/mock/home/.codex/sessions/rollout.jsonl'
        });
    });

    test('opens provider history when a recorded task terminal has already exited', async () => {
        const exitedTerminal = {
            name: 'Task 2. Continue me',
            exitStatus: { code: 0 },
            show: jest.fn()
        };

        await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'resume',
            provider: provider(),
            prompt: 'Resume the task',
            terminal: exitedTerminal as any
        });

        await manager.showSession(taskFilePath, 2, '2. Continue me');

        const terminal = (vscode.window.createTerminal as jest.Mock).mock.results[0].value;
        expect(exitedTerminal.show).not.toHaveBeenCalled();
        expect(terminal.show).toHaveBeenCalled();
        expect(terminal.sendText).toHaveBeenCalledWith('codex resume --last', true);
    });

    test('opens the Claude history session when the task terminal is closed', async () => {
        await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'resume',
            provider: provider({
                id: 'claude',
                displayName: 'Claude Code',
                command: 'claude'
            }),
            prompt: 'Resume the task'
        });

        await manager.showSession(taskFilePath, 2, '2. Continue me');

        const terminal = (vscode.window.createTerminal as jest.Mock).mock.results[0].value;
        expect(vscode.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Claude Code Session - 2. Continue me'
        }));
        expect(terminal.show).toHaveBeenCalled();
        expect(terminal.sendText).toHaveBeenCalledWith('claude --permission-mode bypassPermissions --continue', true);
        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    test('opens a matched Claude provider session by id', async () => {
        providerSessionHistory.findSession.mockResolvedValue({
            sessionId: 'fb2a3577-96ba-48e7-ad43-8e4e063cbb9a',
            filePath: '/mock/home/.claude/projects/E--AITest/fb2a3577-96ba-48e7-ad43-8e4e063cbb9a.jsonl',
            score: 300,
            matchedBy: ['task description', 'completion signal path'],
            updatedAt: 1
        });

        await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'resume',
            provider: provider({
                id: 'claude',
                displayName: 'Claude Code',
                command: 'claude'
            }),
            prompt: 'Resume the task'
        });

        await manager.showSession(taskFilePath, 2, '2. Continue me');

        const terminal = (vscode.window.createTerminal as jest.Mock).mock.results[0].value;
        expect(terminal.sendText).toHaveBeenCalledWith(
            'claude --permission-mode bypassPermissions --resume fb2a3577-96ba-48e7-ad43-8e4e063cbb9a',
            true
        );
    });

    test('shows saved session document with prompt preview for providers without history support', async () => {
        await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'resume',
            provider: provider({
                id: 'custom',
                displayName: 'Custom Agent',
                command: 'custom-agent'
            }),
            prompt: 'Resume the task'
        });

        await manager.showSession(taskFilePath, 2, '2. Continue me');

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({
            language: 'markdown',
            content: expect.stringContaining('Resume the task')
        }));
        expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    test('reads legacy .kfc session store when new store is absent', async () => {
        const legacyStorePath = '/mock/workspace/.autocode/specs/demo/.kfc/task-sessions.json';
        const legacyPromptPath = '/mock/workspace/.autocode/specs/demo/.kfc/session-prompts/session-1-invocation-1.md';
        files.set(legacyStorePath, Buffer.from(JSON.stringify({
            version: 1,
            sessions: [{
                id: 'session-1',
                taskFilePath,
                taskFileRelativePath: '.autocode/specs/demo/tasks.md',
                lineNumber: 2,
                taskDescription: '2. Continue me',
                status: 'inProgress',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                invocations: [{
                    id: 'invocation-1',
                    mode: 'start',
                    startedAt: '2026-01-01T00:00:00.000Z',
                    providerId: 'custom',
                    providerName: 'Custom Agent',
                    promptSnapshotPath: legacyPromptPath
                }]
            }]
        })));
        files.set(legacyPromptPath, Buffer.from('Legacy prompt'));

        await manager.showSession(taskFilePath, 2, '2. Continue me');

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({
            language: 'markdown',
            content: expect.stringContaining('Legacy prompt')
        }));
    });

    function readStore() {
        const storePath = [...files.keys()].find(filePath => filePath.replace(/\\/g, '/').endsWith('/.autocode/task-sessions.json'));
        if (!storePath) {
            throw new Error('task session store was not written');
        }
        return JSON.parse(files.get(storePath)!.toString());
    }

    async function flushPromises(): Promise<void> {
        for (let index = 0; index < 8; index++) {
            await Promise.resolve();
        }
    }

    function provider(overrides: Partial<AgentProviderConfig> = {}): AgentProviderConfig {
        return {
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            model: 'gpt-5.5',
            capabilities: {
                permissions: false,
                expertAgents: true,
                claudeAgents: false,
                claudeHooks: false,
                claudeMcp: false,
                extensionMcp: true,
                headless: true,
                interactiveSpecWorkflow: true
            },
            ...overrides
        };
    }
});
