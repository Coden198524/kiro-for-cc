import * as vscode from 'vscode';
import * as path from 'path';

export type AutoTaskQueueCommandId = 'autocode.spec.implAllTasks' | 'autocode.spec.implAllTasksParallel';
export type AutoTaskQueueStatus = 'running' | 'waiting_for_signal' | 'paused' | 'completed';

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

export class TaskQueueController {
    private queues = new Map<string, AutoTaskQueueRecord>();

    constructor(private outputChannel: vscode.OutputChannel) { }

    async start(documentUri: vscode.Uri, commandId: AutoTaskQueueCommandId): Promise<void> {
        const now = new Date().toISOString();
        await this.writeRecord(documentUri, {
            version: 1,
            taskFilePath: documentUri.fsPath,
            commandId,
            status: 'running',
            startedAt: now,
            updatedAt: now,
            lastEvent: 'Queue started.'
        });
        this.outputChannel.appendLine(`[Task Queue] Started ${commandId}: ${documentUri.fsPath}`);
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
        });
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
        });
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
        });
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
        });
        this.outputChannel.appendLine(`[Task Queue] Completed ${commandId}: ${event}`);
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
        try {
            await vscode.workspace.fs.delete(vscode.Uri.file(getAutoTaskQueueStatePath(documentUri)));
        } catch {
            // The persisted queue file is best-effort state; it may not exist yet.
        }
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

    private async writeRecord(documentUri: vscode.Uri, record: AutoTaskQueueRecord): Promise<void> {
        const normalizedRecord = {
            ...record,
            taskFilePath: documentUri.fsPath,
            updatedAt: new Date().toISOString()
        };
        this.queues.set(this.getQueueKey(documentUri), normalizedRecord);
        const statePath = getAutoTaskQueueStatePath(documentUri);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(statePath)));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(statePath), Buffer.from(JSON.stringify(normalizedRecord, null, 2)));
    }

    private getQueueKey(documentUri: vscode.Uri): string {
        const normalized = path.normalize(documentUri.fsPath);
        return process.platform === 'win32'
            ? normalized.toLowerCase()
            : normalized;
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
