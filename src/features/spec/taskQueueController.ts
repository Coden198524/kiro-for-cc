import * as vscode from 'vscode';
import * as path from 'path';

export type AutoTaskQueueCommandId = 'autocode.spec.implAllTasks' | 'autocode.spec.implAllTasksParallel';
export type AutoTaskQueueStatus = 'running' | 'waiting_for_signal' | 'paused' | 'completed';
export type AutoTaskQueueStartBlockedReason = 'active' | 'invalid_transition';

const AUTO_TASK_QUEUE_STALE_WAIT_MS = 6 * 60 * 60 * 1000;
const ALLOWED_QUEUE_TRANSITIONS: Record<AutoTaskQueueStatus, AutoTaskQueueStatus[]> = {
    running: ['running', 'waiting_for_signal', 'paused', 'completed'],
    waiting_for_signal: ['running', 'waiting_for_signal', 'paused', 'completed'],
    paused: ['running', 'paused', 'completed'],
    completed: ['running', 'completed']
};

export interface AutoTaskQueueTaskState {
    lineNumber: number;
    taskDescription: string;
    completionSignalPath?: string;
    completionSignalToken?: string;
}

export interface AutoTaskQueueRecord {
    version: 1;
    taskFilePath: string;
    commandId: AutoTaskQueueCommandId;
    status: AutoTaskQueueStatus;
    startedAt: string;
    updatedAt: string;
    currentTask?: AutoTaskQueueTaskState;
    batchTasks?: AutoTaskQueueTaskState[];
    lastEvent?: string;
    pauseReason?: string;
}

export interface AutoTaskQueueRecoveryRecord {
    documentUri: vscode.Uri;
    specName: string;
    workspaceFolderName: string;
    record: AutoTaskQueueRecord;
}

export interface AutoTaskQueueStartOptions {
    force?: boolean;
}

export interface AutoTaskQueueSummary {
    statusText: string;
    taskCount: number;
    currentTaskDescription?: string;
    waitHours?: number;
    stale: boolean;
}

export class AutoTaskQueueStartBlockedError extends Error {
    constructor(
        public readonly reason: AutoTaskQueueStartBlockedReason,
        public readonly record: AutoTaskQueueRecord
    ) {
        super(`Auto task queue start blocked: ${reason}`);
    }
}

export function getAutoTaskQueueStatePath(documentUri: vscode.Uri): string {
    return path.join(path.dirname(documentUri.fsPath), '.autocode', 'task-queue.json');
}

export async function readAutoTaskQueueRecord(documentUri: vscode.Uri): Promise<AutoTaskQueueRecord | undefined> {
    try {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(getAutoTaskQueueStatePath(documentUri)));
        const parsed = JSON.parse(Buffer.from(content).toString()) as Partial<AutoTaskQueueRecord>;
        if (!isValidQueueRecord(parsed, documentUri)) {
            return undefined;
        }

        return parsed as AutoTaskQueueRecord;
    } catch {
        return undefined;
    }
}

export async function findRecoverableAutoTaskQueues(
    workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
    specBasePath: string
): Promise<AutoTaskQueueRecoveryRecord[]> {
    if (!workspaceFolders?.length) {
        return [];
    }

    const recoverableQueues: AutoTaskQueueRecoveryRecord[] = [];
    for (const workspaceFolder of workspaceFolders) {
        if (!workspaceFolder?.uri?.fsPath) {
            continue;
        }

        const specsRootPath = resolveWorkspacePath(workspaceFolder.uri.fsPath, specBasePath);
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(specsRootPath));
        } catch {
            continue;
        }
        if (!Array.isArray(entries)) {
            continue;
        }

        for (const [entryName, type] of entries) {
            if (type !== vscode.FileType.Directory) {
                continue;
            }

            const documentUri = vscode.Uri.file(path.join(specsRootPath, entryName, 'tasks.md'));
            const record = await readAutoTaskQueueRecord(documentUri);
            if (!record) {
                continue;
            }

            if (record.status === 'completed') {
                await deleteAutoTaskQueueRecord(documentUri);
                continue;
            }

            recoverableQueues.push({
                documentUri,
                specName: entryName,
                workspaceFolderName: workspaceFolder.name,
                record
            });
        }
    }

    return recoverableQueues.sort((left, right) =>
        left.workspaceFolderName.localeCompare(right.workspaceFolderName) ||
        left.specName.localeCompare(right.specName)
    );
}

export function isAutoTaskQueueActive(record: AutoTaskQueueRecord | undefined): record is AutoTaskQueueRecord {
    return Boolean(record && record.status !== 'completed');
}

export function isAutoTaskQueueStale(record: AutoTaskQueueRecord, now = Date.now()): boolean {
    if (record.status !== 'waiting_for_signal' && record.status !== 'running') {
        return false;
    }

    const updatedAt = Date.parse(record.updatedAt);
    return Number.isFinite(updatedAt) && now - updatedAt > AUTO_TASK_QUEUE_STALE_WAIT_MS;
}

export function getAutoTaskQueueSummary(record: AutoTaskQueueRecord, now = Date.now()): AutoTaskQueueSummary {
    const tasks = getQueuedTasks(record);
    const updatedAt = Date.parse(record.updatedAt);
    const waitHours = Number.isFinite(updatedAt)
        ? Math.max(0, (now - updatedAt) / (60 * 60 * 1000))
        : undefined;

    return {
        statusText: formatQueueStatus(record.status),
        taskCount: tasks.length,
        currentTaskDescription: tasks[0]?.taskDescription,
        waitHours,
        stale: isAutoTaskQueueStale(record, now)
    };
}

export class TaskQueueController {
    private queues = new Map<string, AutoTaskQueueRecord>();

    constructor(private outputChannel: vscode.OutputChannel) { }

    async start(
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId,
        options: AutoTaskQueueStartOptions = {}
    ): Promise<AutoTaskQueueRecord> {
        const existing = await this.getRecord(documentUri);
        if (isAutoTaskQueueActive(existing) && !options.force) {
            throw new AutoTaskQueueStartBlockedError('active', existing);
        }

        const now = new Date().toISOString();
        const record = await this.writeRecord(documentUri, {
            version: 1,
            taskFilePath: documentUri.fsPath,
            commandId,
            status: 'running',
            startedAt: now,
            updatedAt: now,
            lastEvent: 'Queue started.'
        }, existing);
        this.outputChannel.appendLine(`[Task Queue] Started ${commandId}: ${documentUri.fsPath}`);
        return record;
    }

    async waitForTask(
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId,
        task: AutoTaskQueueTaskState
    ): Promise<void> {
        const existing = await this.getRecord(documentUri, commandId);
        await this.writeRecord(documentUri, {
            version: 1,
            taskFilePath: documentUri.fsPath,
            commandId,
            status: 'waiting_for_signal',
            startedAt: existing?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            currentTask: task,
            lastEvent: `Waiting for completion signal on line ${task.lineNumber + 1}.`
        }, existing);
        this.outputChannel.appendLine(`[Task Queue] Waiting for line ${task.lineNumber + 1}: ${task.taskDescription}`);
    }

    async waitForBatch(
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId,
        tasks: AutoTaskQueueTaskState[]
    ): Promise<void> {
        const existing = await this.getRecord(documentUri, commandId);
        await this.writeRecord(documentUri, {
            version: 1,
            taskFilePath: documentUri.fsPath,
            commandId,
            status: 'waiting_for_signal',
            startedAt: existing?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            batchTasks: tasks,
            lastEvent: `Waiting for ${tasks.length} completion signal(s).`
        }, existing);
        this.outputChannel.appendLine(`[Task Queue] Waiting for ${tasks.length} task completion signal(s).`);
    }

    async pause(
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId,
        reason: string,
        lineNumbers: readonly number[] = []
    ): Promise<void> {
        const existing = await this.getRecord(documentUri, commandId);
        const currentTask = existing?.currentTask && (lineNumbers.length === 0 || lineNumbers.includes(existing.currentTask.lineNumber))
            ? existing.currentTask
            : existing?.currentTask;
        await this.writeRecord(documentUri, {
            version: 1,
            taskFilePath: documentUri.fsPath,
            commandId,
            status: 'paused',
            startedAt: existing?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            currentTask,
            batchTasks: existing?.batchTasks,
            lastEvent: reason,
            pauseReason: reason
        }, existing);
        this.outputChannel.appendLine(`[Task Queue] Paused ${commandId}: ${reason}`);
    }

    async complete(documentUri: vscode.Uri, commandId: AutoTaskQueueCommandId, event = 'Queue completed.'): Promise<void> {
        const existing = await this.getRecord(documentUri, commandId);
        await this.writeRecord(documentUri, {
            version: 1,
            taskFilePath: documentUri.fsPath,
            commandId,
            status: 'completed',
            startedAt: existing?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastEvent: event
        }, existing);
        this.outputChannel.appendLine(`[Task Queue] Completed ${commandId}: ${event}`);
    }

    async updateQueuedTasks(
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId,
        tasks: {
            currentTask?: AutoTaskQueueTaskState;
            batchTasks?: AutoTaskQueueTaskState[];
            event?: string;
        }
    ): Promise<void> {
        const existing = await this.getRecord(documentUri, commandId);
        if (!existing) {
            return;
        }

        await this.writeRecord(documentUri, {
            ...existing,
            currentTask: tasks.currentTask,
            batchTasks: tasks.batchTasks,
            lastEvent: tasks.event ?? existing.lastEvent
        }, existing);
    }

    async get(documentUri: vscode.Uri, commandId?: AutoTaskQueueCommandId): Promise<AutoTaskQueueRecord | undefined> {
        return this.getRecord(documentUri, commandId);
    }

    async consumeContinuation(
        documentUri: vscode.Uri,
        lineNumber: number,
        source: string
    ): Promise<AutoTaskQueueCommandId | undefined> {
        const record = await this.getRecord(documentUri);
        if (!record?.currentTask || record.currentTask.lineNumber !== lineNumber) {
            return undefined;
        }

        await this.clear(documentUri);
        this.outputChannel.appendLine(`[Task Queue] Continuing after ${source} on line ${lineNumber + 1}.`);
        return record.commandId;
    }

    async getMatchingQueue(
        documentUri: vscode.Uri,
        lineNumber: number,
        commandId?: AutoTaskQueueCommandId
    ): Promise<AutoTaskQueueRecord | undefined> {
        const record = await this.getRecord(documentUri, commandId);
        if (!record?.currentTask || record.currentTask.lineNumber !== lineNumber) {
            return undefined;
        }

        return record;
    }

    async clear(documentUri: vscode.Uri): Promise<void> {
        this.queues.delete(this.getQueueKey(documentUri));
        await deleteAutoTaskQueueRecord(documentUri);
    }

    private async getRecord(
        documentUri: vscode.Uri,
        commandId?: AutoTaskQueueCommandId
    ): Promise<AutoTaskQueueRecord | undefined> {
        const key = this.getQueueKey(documentUri);
        const cached = this.queues.get(key);
        if (cached && (!commandId || cached.commandId === commandId)) {
            return cached;
        }

        const persisted = await readAutoTaskQueueRecord(documentUri);
        if (!persisted || (commandId && persisted.commandId !== commandId)) {
            return undefined;
        }

        this.queues.set(key, persisted);
        return persisted;
    }

    private async writeRecord(
        documentUri: vscode.Uri,
        record: AutoTaskQueueRecord,
        existing?: AutoTaskQueueRecord
    ): Promise<AutoTaskQueueRecord> {
        this.assertValidTransition(existing, record.status);
        const normalizedRecord = {
            ...record,
            taskFilePath: documentUri.fsPath,
            updatedAt: new Date().toISOString()
        };
        this.queues.set(this.getQueueKey(documentUri), normalizedRecord);
        const statePath = getAutoTaskQueueStatePath(documentUri);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(statePath)));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(statePath), Buffer.from(JSON.stringify(normalizedRecord, null, 2)));
        return normalizedRecord;
    }

    private getQueueKey(documentUri: vscode.Uri): string {
        const normalized = path.normalize(documentUri.fsPath);
        return process.platform === 'win32'
            ? normalized.toLowerCase()
            : normalized;
    }

    private assertValidTransition(existing: AutoTaskQueueRecord | undefined, nextStatus: AutoTaskQueueStatus): void {
        if (!existing) {
            return;
        }

        const allowed = ALLOWED_QUEUE_TRANSITIONS[existing.status] ?? [];
        if (!allowed.includes(nextStatus)) {
            throw new AutoTaskQueueStartBlockedError('invalid_transition', existing);
        }
    }
}

function isValidQueueRecord(record: Partial<AutoTaskQueueRecord>, documentUri: vscode.Uri): boolean {
    if (record.version !== 1 || !record.taskFilePath || !record.commandId || !record.status) {
        return false;
    }

    if (!['autocode.spec.implAllTasks', 'autocode.spec.implAllTasksParallel'].includes(record.commandId)) {
        return false;
    }

    if (!['running', 'waiting_for_signal', 'paused', 'completed'].includes(record.status)) {
        return false;
    }

    return normalizeFsPath(record.taskFilePath) === normalizeFsPath(documentUri.fsPath);
}

function normalizeFsPath(filePath: string): string {
    const normalized = path.normalize(filePath);
    return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
}

async function deleteAutoTaskQueueRecord(documentUri: vscode.Uri): Promise<void> {
    try {
        await vscode.workspace.fs.delete(vscode.Uri.file(getAutoTaskQueueStatePath(documentUri)));
    } catch {
        // The persisted queue file is best-effort state; it may not exist yet.
    }
}

function getQueuedTasks(record: AutoTaskQueueRecord): AutoTaskQueueTaskState[] {
    return [
        ...(record.currentTask ? [record.currentTask] : []),
        ...(record.batchTasks ?? [])
    ];
}

function formatQueueStatus(status: string): string {
    return status.replace(/_/g, ' ');
}

function resolveWorkspacePath(workspacePath: string, relativeOrAbsolutePath: string): string {
    return path.isAbsolute(relativeOrAbsolutePath)
        ? relativeOrAbsolutePath
        : path.join(workspacePath, relativeOrAbsolutePath);
}
