import * as vscode from 'vscode';
import { TaskSessionManager } from '../../../../src/features/spec/taskSessionManager';
import { AgentProviderConfig } from '../../../../src/runtime/agentRuntime';

describe('TaskSessionManager', () => {
    const taskFilePath = '/mock/workspace/.autocode/specs/demo/tasks.md';
    let files: Map<string, Buffer>;
    let manager: TaskSessionManager;

    beforeEach(() => {
        jest.clearAllMocks();
        files = new Map();
        manager = new TaskSessionManager({ appendLine: jest.fn() } as any);

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
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({ uri: vscode.Uri.file('/preview.md') });
        (vscode.window.showTextDocument as jest.Mock).mockResolvedValue(undefined);
    });

    test('records task invocation with prompt snapshot and provider metadata', async () => {
        const session = await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'start',
            provider: provider(),
            prompt: 'Implement the task',
            terminal: { name: 'KFC - Implementing Task' } as any
        });

        expect(session.status).toBe('inProgress');
        expect(session.invocations).toHaveLength(1);
        expect(session.invocations[0]).toMatchObject({
            mode: 'start',
            providerName: 'Codex',
            terminalName: 'KFC - Implementing Task'
        });

        const store = readStore();
        expect(store.sessions).toHaveLength(1);
        expect(files.get(session.invocations[0].promptSnapshotPath)?.toString()).toBe('Implement the task');
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

    test('shows saved session document with prompt preview', async () => {
        await manager.recordInvocation({
            taskFilePath,
            lineNumber: 2,
            taskDescription: '2. Continue me',
            mode: 'resume',
            provider: provider(),
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
                    providerId: 'codex',
                    providerName: 'Codex',
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

    function provider(): AgentProviderConfig {
        return {
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            model: 'gpt-5.5',
            capabilities: {
                permissions: false,
                claudeAgents: false,
                claudeHooks: false,
                claudeMcp: false,
                extensionMcp: true,
                headless: true,
                interactiveSpecWorkflow: true
            }
        };
    }
});
