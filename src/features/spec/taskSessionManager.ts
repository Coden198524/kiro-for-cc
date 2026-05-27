import * as vscode from 'vscode';
import * as path from 'path';
import { AgentProviderConfig } from '../../runtime/agentRuntime';
import { getProviderConfig, isAgentProviderId } from '../../runtime/providerRegistry';
import { quoteCommand, quoteShellArg } from '../../runtime/agentCommandBuilder';
import { getRuntimeValue } from '../../runtime/runtimeSettings';
import { ProviderSessionHistory, ProviderSessionHistoryMatch } from './providerSessionHistory';
import { MemoryManager } from '../memory/memoryManager';
import { ConfigManager } from '../../utils/configManager';

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
    providerSessionId?: string;
    providerSessionPath?: string;
    runId?: string;
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
    runId?: string;
    terminal?: vscode.Terminal;
}

export class TaskSessionManager {
    private activeTerminals = new Map<string, vscode.Terminal>();

    constructor(
        private outputChannel: vscode.OutputChannel,
        private providerSessionHistory = new ProviderSessionHistory({ outputChannel }),
        private memoryManager?: MemoryManager
    ) {
        vscode.window.onDidCloseTerminal(terminal => {
            this.forgetTerminal(terminal);
        });
        this.cleanupExpiredSessionPromptFiles().catch(error => {
            this.outputChannel.appendLine(`[TaskSession] Failed to cleanup expired prompt snapshots: ${error}`);
        });
    }

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
            runId: request.runId,
            promptSnapshotPath
        };

        session.invocations.push(invocation);
        if (request.terminal) {
            this.activeTerminals.set(invocationId, request.terminal);
        }

        await this.writeStore(request.taskFilePath, store);
        await this.memoryManager?.recordSessionInvocation({
            taskFilePath: request.taskFilePath,
            taskDescription: request.taskDescription,
            lineNumber: request.lineNumber,
            sessionId: session.id,
            invocationId,
            providerName: request.provider.displayName,
            providerSessionId: invocation.providerSessionId,
            promptSnapshotPath
        });
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

        const latestInvocation = session.invocations[session.invocations.length - 1];
        if (latestInvocation && this.openActiveTerminal(latestInvocation)) {
            return;
        }

        if (latestInvocation && await this.openProviderHistoryTerminal(store, session, latestInvocation)) {
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

    private openActiveTerminal(invocation: TaskInvocationRecord): boolean {
        const terminal = this.activeTerminals.get(invocation.id);
        if (!terminal) {
            return false;
        }

        if (terminal.exitStatus !== undefined) {
            this.activeTerminals.delete(invocation.id);
            return false;
        }

        terminal.show();
        return true;
    }

    private forgetTerminal(terminal: vscode.Terminal): void {
        for (const [invocationId, activeTerminal] of this.activeTerminals) {
            if (activeTerminal === terminal) {
                this.activeTerminals.delete(invocationId);
            }
        }
    }

    private async openProviderHistoryTerminal(
        store: TaskSessionStore,
        session: TaskSessionRecord,
        invocation: TaskInvocationRecord
    ): Promise<boolean> {
        const existingProviderSessionId = invocation.providerSessionId;
        const command = await this.buildProviderHistoryCommand(session, invocation);
        if (!command) {
            return false;
        }

        if (invocation.providerSessionId && invocation.providerSessionId !== existingProviderSessionId) {
            await this.writeStore(session.taskFilePath, store);
        }

        const terminal = vscode.window.createTerminal({
            name: `${invocation.providerName} Session - ${this.formatTaskTitle(session.taskDescription)}`,
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            location: { viewColumn: vscode.ViewColumn.Two }
        });
        terminal.show();
        terminal.sendText(command, true);
        return true;
    }

    private async buildProviderHistoryCommand(
        session: TaskSessionRecord,
        invocation: TaskInvocationRecord
    ): Promise<string | undefined> {
        if (!isAgentProviderId(invocation.providerId)) {
            return undefined;
        }

        const provider = getProviderConfig(invocation.providerId);
        const command = quoteCommand(provider.command, provider.displayName);
        const providerSessionId = await this.resolveProviderSessionId(session, invocation);

        if (provider.id === 'codex') {
            const args = (provider.args ?? []).map(arg => quoteShellArg(arg)).join(' ');
            const resumeTarget = providerSessionId
                ? `resume ${quoteShellArg(providerSessionId)}`
                : 'resume --last';
            return [command, args, resumeTarget].filter(Boolean).join(' ');
        }

        if (provider.id === 'claude') {
            const resumeTarget = providerSessionId
                ? `--resume ${quoteShellArg(providerSessionId)}`
                : '--continue';
            return `${command} --permission-mode bypassPermissions ${resumeTarget}`;
        }

        return undefined;
    }

    private async resolveProviderSessionId(
        session: TaskSessionRecord,
        invocation: TaskInvocationRecord
    ): Promise<string | undefined> {
        if (invocation.providerSessionId) {
            return invocation.providerSessionId;
        }

        if (!isAgentProviderId(invocation.providerId)) {
            return undefined;
        }

        const match = await this.providerSessionHistory.findSession({
            providerId: invocation.providerId,
            taskFilePath: session.taskFilePath,
            taskDescription: session.taskDescription,
            promptSnapshotPath: invocation.promptSnapshotPath
        });

        if (!match) {
            this.outputChannel.appendLine(`[TaskSession] No ${invocation.providerName} history match found for task: ${session.taskDescription}`);
            return undefined;
        }

        this.recordProviderSessionMatch(invocation, match);
        this.outputChannel.appendLine(`[TaskSession] Matched ${invocation.providerName} history session ${match.sessionId}: ${match.filePath}`);
        return match.sessionId;
    }

    private recordProviderSessionMatch(invocation: TaskInvocationRecord, match: ProviderSessionHistoryMatch): void {
        invocation.providerSessionId = match.sessionId;
        invocation.providerSessionPath = match.filePath;
    }

    private formatTaskTitle(taskDescription: string): string {
        const title = taskDescription.trim().replace(/\s+/g, ' ');
        if (title.length <= 80) {
            return title || 'Task';
        }

        return `${title.slice(0, 77)}...`;
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
            `- Run ID: ${invocation.runId || '(not recorded)'}`,
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

    private async cleanupExpiredSessionPromptFiles(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) {
            return;
        }

        const retentionMs = this.getPromptFileRetentionMs();
        const now = Date.now();
        const configManager = ConfigManager.getInstance();
        await configManager.loadSettings();
        const specBasePath = configManager.getPath('specs');

        for (const workspaceFolder of workspaceFolders) {
            const specsRoot = path.isAbsolute(specBasePath)
                ? specBasePath
                : path.join(workspaceFolder.uri.fsPath, specBasePath);
            await this.cleanupSessionPromptRoot(specsRoot, retentionMs, now);
        }
    }

    private async cleanupSessionPromptRoot(specsRoot: string, retentionMs: number, now: number): Promise<void> {
        let specEntries: [string, vscode.FileType][];
        try {
            specEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(specsRoot));
        } catch {
            return;
        }

        if (!Array.isArray(specEntries)) {
            return;
        }

        for (const [specName, type] of specEntries) {
            if (type !== vscode.FileType.Directory) {
                continue;
            }

            await this.cleanupExpiredFilesInDirectory(
                path.join(specsRoot, specName, '.autocode', 'session-prompts'),
                /\.md$/i,
                retentionMs,
                now
            );
        }
    }

    private async cleanupExpiredFilesInDirectory(
        directoryPath: string,
        fileNamePattern: RegExp,
        retentionMs: number,
        now: number
    ): Promise<void> {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directoryPath));
        } catch {
            return;
        }

        if (!Array.isArray(entries)) {
            return;
        }

        for (const [fileName, type] of entries) {
            if (type !== vscode.FileType.File || !fileNamePattern.test(fileName)) {
                continue;
            }

            const fileUri = vscode.Uri.file(path.join(directoryPath, fileName));
            try {
                const stat = await vscode.workspace.fs.stat(fileUri);
                if (typeof stat.mtime === 'number' && now - stat.mtime > retentionMs) {
                    await vscode.workspace.fs.delete(fileUri);
                    this.outputChannel.appendLine(`[TaskSession] Cleaned up expired prompt snapshot: ${fileUri.fsPath}`);
                }
            } catch (error) {
                this.outputChannel.appendLine(`[TaskSession] Failed to cleanup prompt snapshot ${fileUri.fsPath}: ${error}`);
            }
        }
    }

    private getPromptFileRetentionMs(): number {
        const retentionDays = getRuntimeValue<number>('promptFileRetentionDays', 7);
        const normalizedDays = typeof retentionDays === 'number' && Number.isFinite(retentionDays)
            ? Math.max(0, retentionDays)
            : 7;
        return normalizedDays * 24 * 60 * 60 * 1000;
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
