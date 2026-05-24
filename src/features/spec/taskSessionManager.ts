import * as vscode from 'vscode';
import * as path from 'path';
import { AgentProviderConfig } from '../../runtime/agentRuntime';

export type TaskSessionStatus = 'inProgress' | 'completed';
export type TaskInvocationMode = 'start' | 'resume';

export interface TaskInvocationRecord {
    id: string;
    mode: TaskInvocationMode;
    startedAt: string;
    providerId: string;
    providerName: string;
    model?: string;
    terminalName?: string;
    promptSnapshotPath: string;
}

export interface TaskSessionRecord {
    id: string;
    taskFilePath: string;
    taskFileRelativePath: string;
    lineNumber: number;
    taskDescription: string;
    status: TaskSessionStatus;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    invocations: TaskInvocationRecord[];
}

interface TaskSessionStore {
    version: 1;
    sessions: TaskSessionRecord[];
}

export interface RecordTaskInvocationRequest {
    taskFilePath: string;
    lineNumber: number;
    taskDescription: string;
    mode: TaskInvocationMode;
    provider: AgentProviderConfig;
    prompt: string;
    terminal?: vscode.Terminal;
}

export class TaskSessionManager {
    private activeTerminals = new Map<string, vscode.Terminal>();

    constructor(private outputChannel: vscode.OutputChannel) { }

    async recordInvocation(request: RecordTaskInvocationRequest): Promise<TaskSessionRecord> {
        const now = new Date().toISOString();
        const store = await this.readStore(request.taskFilePath);
        let session = this.findLatestSession(store.sessions, request.taskFilePath, request.lineNumber, request.taskDescription);

        if (!session || (request.mode === 'start' && session.status === 'completed')) {
            session = this.createSession(request, now);
            store.sessions.push(session);
        }

        session.status = 'inProgress';
        session.updatedAt = now;
        session.lineNumber = request.lineNumber;
        session.taskDescription = request.taskDescription;
        session.completedAt = undefined;

        const invocationId = this.createId('invocation');
        const promptSnapshotPath = await this.writePromptSnapshot(request.taskFilePath, session.id, invocationId, request.prompt);

        const invocation: TaskInvocationRecord = {
            id: invocationId,
            mode: request.mode,
            startedAt: now,
            providerId: request.provider.id,
            providerName: request.provider.displayName,
            model: request.provider.model,
            terminalName: request.terminal?.name,
            promptSnapshotPath
        };

        session.invocations.push(invocation);
        if (request.terminal) {
            this.activeTerminals.set(invocationId, request.terminal);
        }

        await this.writeStore(request.taskFilePath, store);
        return session;
    }

    async markCompleted(taskFilePath: string, lineNumber: number, taskDescription: string): Promise<TaskSessionRecord | undefined> {
        const store = await this.readStore(taskFilePath);
        const session = this.findLatestSession(store.sessions, taskFilePath, lineNumber, taskDescription);
        if (!session) {
            return undefined;
        }

        const now = new Date().toISOString();
        session.status = 'completed';
        session.updatedAt = now;
        session.completedAt = now;

        await this.writeStore(taskFilePath, store);
        return session;
    }

    async showSession(taskFilePath: string, lineNumber: number, taskDescription: string): Promise<void> {
        const store = await this.readStore(taskFilePath);
        const session = this.findLatestSession(store.sessions, taskFilePath, lineNumber, taskDescription);
        if (!session) {
            vscode.window.showWarningMessage('No saved AI session was found for this task.');
            return;
        }

        const content = await this.renderSessionDocument(session);
        const document = await vscode.workspace.openTextDocument({
            content,
            language: 'markdown'
        });
        await vscode.window.showTextDocument(document, {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside
        });
    }

    private createSession(request: RecordTaskInvocationRequest, now: string): TaskSessionRecord {
        return {
            id: this.createId('session'),
            taskFilePath: request.taskFilePath,
            taskFileRelativePath: this.getWorkspaceRelativePath(request.taskFilePath),
            lineNumber: request.lineNumber,
            taskDescription: request.taskDescription,
            status: 'inProgress',
            createdAt: now,
            updatedAt: now,
            invocations: []
        };
    }

    private async renderSessionDocument(session: TaskSessionRecord): Promise<string> {
        const latestInvocation = session.invocations[session.invocations.length - 1];
        const terminalAvailable = latestInvocation ? this.activeTerminals.has(latestInvocation.id) : false;
        const promptPreview = latestInvocation
            ? await this.readPromptPreview(latestInvocation.promptSnapshotPath)
            : 'No prompt snapshot was saved.';

        const invocations = session.invocations.map((invocation, index) => [
            `### Invocation ${index + 1}`,
            '',
            `- Mode: ${invocation.mode}`,
            `- Started: ${invocation.startedAt}`,
            `- Provider: ${invocation.providerName}`,
            `- Model: ${invocation.model || '(default)'}`,
            `- Terminal: ${invocation.terminalName || '(not recorded)'}`,
            `- Prompt Snapshot: ${invocation.promptSnapshotPath}`
        ].join('\n')).join('\n\n');

        return [
            '# AI Task Session',
            '',
            `- Session ID: ${session.id}`,
            `- Status: ${session.status}`,
            `- Task: ${session.taskDescription}`,
            `- Task File: ${session.taskFileRelativePath}`,
            `- Task Line: ${session.lineNumber + 1}`,
            `- Created: ${session.createdAt}`,
            `- Updated: ${session.updatedAt}`,
            `- Completed: ${session.completedAt || '(not completed)'}`,
            `- Latest Terminal Still Open: ${terminalAvailable ? 'yes' : 'unknown or closed'}`,
            '',
            '## Invocations',
            '',
            invocations || 'No invocations recorded.',
            '',
            '## Latest Prompt Snapshot',
            '',
            latestInvocation ? `Path: ${latestInvocation.promptSnapshotPath}` : 'Path: (not recorded)',
            '',
            this.toCodeBlock(promptPreview, 'text')
        ].join('\n');
    }

    private async readPromptPreview(promptSnapshotPath: string): Promise<string> {
        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(promptSnapshotPath));
            const text = Buffer.from(content).toString();
            const maxLength = 12000;
            return text.length > maxLength
                ? `${text.slice(0, maxLength)}\n\n[Prompt snapshot truncated in this view. Open the snapshot file for full content.]`
                : text;
        } catch (error) {
            this.outputChannel.appendLine(`[TaskSession] Failed to read prompt snapshot: ${error}`);
            return 'Prompt snapshot could not be read.';
        }
    }

    private toCodeBlock(content: string, language: string): string {
        return `~~~~${language}\n${content}\n~~~~`;
    }

    private findLatestSession(
        sessions: TaskSessionRecord[],
        taskFilePath: string,
        lineNumber: number,
        taskDescription: string
    ): TaskSessionRecord | undefined {
        const normalizedPath = this.normalizePath(taskFilePath);
        const byPath = sessions.filter(session => this.normalizePath(session.taskFilePath) === normalizedPath);

        const exact = byPath.filter(session =>
            session.lineNumber === lineNumber &&
            session.taskDescription === taskDescription
        );
        const byDescription = byPath.filter(session => session.taskDescription === taskDescription);

        return [...exact, ...byDescription]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    }

    private async writePromptSnapshot(
        taskFilePath: string,
        sessionId: string,
        invocationId: string,
        prompt: string
    ): Promise<string> {
        const promptDir = path.join(this.getAutocodeDir(taskFilePath), 'session-prompts');
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(promptDir));

        const promptPath = path.join(promptDir, `${sessionId}-${invocationId}.md`);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(promptPath), Buffer.from(prompt));
        return promptPath;
    }

    private async readStore(taskFilePath: string): Promise<TaskSessionStore> {
        const storePaths = [
            this.getStorePath(taskFilePath),
            this.getLegacyStorePath(taskFilePath)
        ];

        for (const storePath of storePaths) {
            try {
                const content = await vscode.workspace.fs.readFile(vscode.Uri.file(storePath));
                const parsed = JSON.parse(Buffer.from(content).toString()) as Partial<TaskSessionStore>;
                return {
                    version: 1,
                    sessions: Array.isArray(parsed.sessions) ? parsed.sessions as TaskSessionRecord[] : []
                };
            } catch {
                // Try the next store location.
            }
        }

        return {
            version: 1,
            sessions: []
        };
    }

    private async writeStore(taskFilePath: string, store: TaskSessionStore): Promise<void> {
        const autocodeDir = this.getAutocodeDir(taskFilePath);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(autocodeDir));
        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(this.getStorePath(taskFilePath)),
            Buffer.from(JSON.stringify(store, null, 2))
        );
    }

    private getStorePath(taskFilePath: string): string {
        return path.join(this.getAutocodeDir(taskFilePath), 'task-sessions.json');
    }

    private getLegacyStorePath(taskFilePath: string): string {
        return path.join(path.dirname(taskFilePath), '.kfc', 'task-sessions.json');
    }

    private getAutocodeDir(taskFilePath: string): string {
        return path.join(path.dirname(taskFilePath), '.autocode');
    }

    private getWorkspaceRelativePath(filePath: string): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return filePath;
        }

        return path.relative(workspaceFolder.uri.fsPath, filePath) || filePath;
    }

    private normalizePath(filePath: string): string {
        return path.normalize(filePath).replace(/\\/g, '/').toLowerCase();
    }

    private createId(prefix: string): string {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
}
