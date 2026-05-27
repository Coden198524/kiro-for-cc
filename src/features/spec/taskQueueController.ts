import * as vscode from 'vscode';
import * as path from 'path';

export type AutoTaskQueueCommandId = 'autocode.spec.implAllTasks' | 'autocode.spec.implAllTasksParallel';
export type AutoTaskQueueStatus = 'running' | 'waiting_for_signal' | 'paused' | 'completed';
export type AutoTaskQueueStartBlockedReason = 'active' | 'invalid_transition';

const AUTO_TASK_QUEUE_STALE_WAIT_MS = 6 * 60 * 60 * 1000;
const AUTO_TASK_QUEUE_LOCK_RETRY_MS = 50;
const AUTO_TASK_QUEUE_LOCK_TIMEOUT_MS = 5000;
const AUTO_TASK_QUEUE_LOCK_STALE_MS = 2 * 60 * 1000;
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
    queueRunId: string;
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

interface AutoTaskQueueLockRecord {
    owner: string;
    createdAt: string;
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

export interface AutoTaskQueueLockSummary {
    path: string;
    status: 'absent' | 'active' | 'stale';
    owner?: string;
    createdAt?: string;
    ageMs?: number;
}

export interface AutoTaskQueueDiagnostics {
    taskFilePath: string;
    statePath: string;
    lock: AutoTaskQueueLockSummary;
    record?: AutoTaskQueueRecord;
    summary?: AutoTaskQueueSummary;
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

export function getAutoTaskQueueLockPath(documentUri: vscode.Uri): string {
    return path.join(path.dirname(documentUri.fsPath), '.autocode', 'task-queue.lock');
}

export async function readAutoTaskQueueRecord(documentUri: vscode.Uri): Promise<AutoTaskQueueRecord | undefined> {
    try {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(getAutoTaskQueueStatePath(documentUri)));
        const parsed = JSON.parse(Buffer.from(content).toString()) as Partial<AutoTaskQueueRecord>;
        if (!isValidQueueRecord(parsed, documentUri)) {
            return undefined;
        }

        return normalizeQueueRecord(parsed, documentUri);
    } catch {
        return undefined;
    }
}

export async function getAutoTaskQueueDiagnostics(
    documentUri: vscode.Uri,
    now = Date.now()
): Promise<AutoTaskQueueDiagnostics> {
    const record = await readAutoTaskQueueRecord(documentUri);
    const lockPath = getAutoTaskQueueLockPath(documentUri);
    const lock = await readAutoTaskQueueLock(vscode.Uri.file(lockPath));
    return {
        taskFilePath: documentUri.fsPath,
        statePath: getAutoTaskQueueStatePath(documentUri),
        lock: summarizeAutoTaskQueueLock(lockPath, lock, now),
        record,
        summary: record ? getAutoTaskQueueSummary(record, now) : undefined
    };
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
    private static readonly startLocks = new Map<string, Promise<void>>();
    private queues = new Map<string, AutoTaskQueueRecord>();

    constructor(private outputChannel: vscode.OutputChannel) { }

    async start(
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId,
        options: AutoTaskQueueStartOptions = {}
    ): Promise<AutoTaskQueueRecord> {
        return this.withStartLock(documentUri, async () => {
            return this.withFileLock(documentUri, async () => {
                const existing = await this.getPersistedRecord(documentUri);
                if (isAutoTaskQueueActive(existing) && !options.force) {
                    throw new AutoTaskQueueStartBlockedError('active', existing);
                }

                const now = new Date().toISOString();
                const record = await this.writeRecord(documentUri, {
                    version: 1,
                    queueRunId: createQueueRunId(),
                    taskFilePath: documentUri.fsPath,
                    commandId,
                    status: 'running',
                    startedAt: now,
                    updatedAt: now,
                    lastEvent: 'Queue started.'
                }, existing);
                this.outputChannel.appendLine(`[Task Queue] Started ${commandId}: ${documentUri.fsPath}`);
                return record;
            });
        });
    }

    async waitForTask(
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId,
        task: AutoTaskQueueTaskState
    ): Promise<AutoTaskQueueRecord> {
        const record = await this.withFileLock(documentUri, async () => {
            const existing = await this.getPersistedRecord(documentUri, commandId);
            return this.writeRecord(documentUri, {
                version: 1,
                queueRunId: existing?.queueRunId ?? createQueueRunId(),
                taskFilePath: documentUri.fsPath,
                commandId,
                status: 'waiting_for_signal',
                startedAt: existing?.startedAt ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                currentTask: task,
                lastEvent: `Waiting for completion signal on line ${task.lineNumber + 1}.`
            }, existing);
        });
        this.outputChannel.appendLine(`[Task Queue] Waiting for line ${task.lineNumber + 1}: ${task.taskDescription}`);
        return record;
    }

    async waitForBatch(
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId,
        tasks: AutoTaskQueueTaskState[]
    ): Promise<AutoTaskQueueRecord> {
        const record = await this.withFileLock(documentUri, async () => {
            const existing = await this.getPersistedRecord(documentUri, commandId);
            return this.writeRecord(documentUri, {
                version: 1,
                queueRunId: existing?.queueRunId ?? createQueueRunId(),
                taskFilePath: documentUri.fsPath,
                commandId,
                status: 'waiting_for_signal',
                startedAt: existing?.startedAt ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                batchTasks: tasks,
                lastEvent: `Waiting for ${tasks.length} completion signal(s).`
            }, existing);
        });
        this.outputChannel.appendLine(`[Task Queue] Waiting for ${tasks.length} task completion signal(s).`);
        return record;
    }

    async pause(
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId,
        reason: string,
        lineNumbers: readonly number[] = []
    ): Promise<void> {
        await this.withFileLock(documentUri, async () => {
            const existing = await this.getPersistedRecord(documentUri, commandId);
            const pausedTasks = this.getPausedQueueTasks(existing, lineNumbers);
            await this.writeRecord(documentUri, {
                version: 1,
                queueRunId: existing?.queueRunId ?? createQueueRunId(),
                taskFilePath: documentUri.fsPath,
                commandId,
                status: 'paused',
                startedAt: existing?.startedAt ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                currentTask: pausedTasks.currentTask,
                batchTasks: pausedTasks.batchTasks,
                lastEvent: reason,
                pauseReason: reason
            }, existing);
        });
        this.outputChannel.appendLine(`[Task Queue] Paused ${commandId}: ${reason}`);
    }

    async complete(documentUri: vscode.Uri, commandId: AutoTaskQueueCommandId, event = 'Queue completed.'): Promise<void> {
        await this.withFileLock(documentUri, async () => {
            const existing = await this.getPersistedRecord(documentUri, commandId);
            await this.writeRecord(documentUri, {
                version: 1,
                queueRunId: existing?.queueRunId ?? createQueueRunId(),
                taskFilePath: documentUri.fsPath,
                commandId,
                status: 'completed',
                startedAt: existing?.startedAt ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastEvent: event
            }, existing);
        });
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
        await this.withFileLock(documentUri, async () => {
            const existing = await this.getPersistedRecord(documentUri, commandId);
            if (!existing) {
                return;
            }

            await this.writeRecord(documentUri, {
                ...existing,
                currentTask: tasks.currentTask,
                batchTasks: tasks.batchTasks,
                lastEvent: tasks.event ?? existing.lastEvent
            }, existing);
        });
    }

    async get(documentUri: vscode.Uri, commandId?: AutoTaskQueueCommandId): Promise<AutoTaskQueueRecord | undefined> {
        return this.getRecord(documentUri, commandId);
    }

    async consumeContinuation(
        documentUri: vscode.Uri,
        lineNumber: number,
        source: string
    ): Promise<AutoTaskQueueCommandId | undefined> {
        return this.withFileLock(documentUri, async () => {
            const record = await this.getPersistedRecord(documentUri);
            if (!record?.currentTask || record.currentTask.lineNumber !== lineNumber) {
                return undefined;
            }

            await this.clearRecord(documentUri);
            this.outputChannel.appendLine(`[Task Queue] Continuing after ${source} on line ${lineNumber + 1}.`);
            return record.commandId;
        });
    }

    async getMatchingQueue(
        documentUri: vscode.Uri,
        lineNumber: number,
        commandId?: AutoTaskQueueCommandId,
        queueRunId?: string
    ): Promise<AutoTaskQueueRecord | undefined> {
        const record = await this.getPersistedRecord(documentUri, commandId);
        if (queueRunId && record?.queueRunId !== queueRunId) {
            return undefined;
        }

        if (!record?.currentTask || record.currentTask.lineNumber !== lineNumber) {
            return undefined;
        }

        return record;
    }

    async getMatchingBatchQueue(
        documentUri: vscode.Uri,
        tasks: readonly AutoTaskQueueTaskState[],
        commandId?: AutoTaskQueueCommandId,
        queueRunId?: string
    ): Promise<AutoTaskQueueRecord | undefined> {
        const record = await this.getPersistedRecord(documentUri, commandId);
        if (queueRunId && record?.queueRunId !== queueRunId) {
            return undefined;
        }

        if (!record?.batchTasks || record.batchTasks.length !== tasks.length) {
            return undefined;
        }

        const matches = tasks.every((task, index) => {
            const recordedTask = record.batchTasks?.[index];
            return Boolean(recordedTask &&
                recordedTask.lineNumber === task.lineNumber &&
                recordedTask.taskDescription === task.taskDescription &&
                recordedTask.completionSignalPath === task.completionSignalPath &&
                recordedTask.completionSignalToken === task.completionSignalToken);
        });

        return matches ? record : undefined;
    }

    async clear(documentUri: vscode.Uri): Promise<void> {
        await this.withFileLock(documentUri, async () => {
            await this.clearRecord(documentUri);
        });
    }

    private async getPersistedRecord(
        documentUri: vscode.Uri,
        commandId?: AutoTaskQueueCommandId
    ): Promise<AutoTaskQueueRecord | undefined> {
        const key = this.getQueueKey(documentUri);
        const persisted = await readAutoTaskQueueRecord(documentUri);
        if (!persisted || (commandId && persisted.commandId !== commandId)) {
            this.queues.delete(key);
            return undefined;
        }

        this.queues.set(key, persisted);
        return persisted;
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
            queueRunId: record.queueRunId || existing?.queueRunId || createQueueRunId(),
            taskFilePath: documentUri.fsPath,
            updatedAt: new Date().toISOString()
        };
        this.queues.set(this.getQueueKey(documentUri), normalizedRecord);
        const statePath = getAutoTaskQueueStatePath(documentUri);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(statePath)));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(statePath), Buffer.from(JSON.stringify(normalizedRecord, null, 2)));
        return normalizedRecord;
    }

    private async clearRecord(documentUri: vscode.Uri): Promise<void> {
        this.queues.delete(this.getQueueKey(documentUri));
        await deleteAutoTaskQueueRecord(documentUri);
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

    private getPausedQueueTasks(
        existing: AutoTaskQueueRecord | undefined,
        lineNumbers: readonly number[]
    ): { currentTask?: AutoTaskQueueTaskState; batchTasks?: AutoTaskQueueTaskState[] } {
        if (!existing || lineNumbers.length === 0) {
            return {
                currentTask: existing?.currentTask,
                batchTasks: existing?.batchTasks
            };
        }

        const pausedLineNumbers = new Set(lineNumbers);
        const currentTask = existing.currentTask && pausedLineNumbers.has(existing.currentTask.lineNumber)
            ? existing.currentTask
            : undefined;
        const batchTasks = existing.batchTasks?.filter(task => pausedLineNumbers.has(task.lineNumber));

        return {
            currentTask,
            batchTasks: batchTasks && batchTasks.length > 0 ? batchTasks : undefined
        };
    }

    private async withStartLock<T>(documentUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
        const key = this.getQueueKey(documentUri);
        const previous = TaskQueueController.startLocks.get(key) ?? Promise.resolve();
        let releaseLock: () => void = () => undefined;
        const currentLock = new Promise<void>(resolve => {
            releaseLock = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => currentLock);
        TaskQueueController.startLocks.set(key, tail);

        await previous.catch(() => undefined);
        try {
            return await action();
        } finally {
            releaseLock();
            if (TaskQueueController.startLocks.get(key) === tail) {
                TaskQueueController.startLocks.delete(key);
            }
        }
    }

    private async withFileLock<T>(documentUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
        const owner = createQueueRunId();
        const lockPath = getAutoTaskQueueLockPath(documentUri);
        const lockUri = vscode.Uri.file(lockPath);
        const startedAt = Date.now();
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(lockPath)));

        while (Date.now() - startedAt <= AUTO_TASK_QUEUE_LOCK_TIMEOUT_MS) {
            if (await this.tryAcquireFileLock(lockUri, owner)) {
                try {
                    return await action();
                } finally {
                    await this.releaseFileLock(lockUri, owner);
                }
            }

            await this.wait(AUTO_TASK_QUEUE_LOCK_RETRY_MS);
        }

        throw new Error(`Timed out waiting for auto task queue lock: ${lockPath}`);
    }

    private async tryAcquireFileLock(lockUri: vscode.Uri, owner: string): Promise<boolean> {
        const existing = await readAutoTaskQueueLock(lockUri);
        if (existing && !isAutoTaskQueueLockStale(existing)) {
            return false;
        }

        if (existing) {
            await deleteAutoTaskQueueLock(lockUri);
        }

        await vscode.workspace.fs.writeFile(lockUri, Buffer.from(JSON.stringify({
            owner,
            createdAt: new Date().toISOString()
        })));

        const confirmed = await readAutoTaskQueueLock(lockUri);
        return confirmed?.owner === owner;
    }

    private async releaseFileLock(lockUri: vscode.Uri, owner: string): Promise<void> {
        const existing = await readAutoTaskQueueLock(lockUri);
        if (existing?.owner === owner) {
            await deleteAutoTaskQueueLock(lockUri);
        }
    }

    private async wait(milliseconds: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, milliseconds));
    }
}

function normalizeQueueRecord(record: Partial<AutoTaskQueueRecord>, documentUri: vscode.Uri): AutoTaskQueueRecord | undefined {
    if (!isValidQueueRecord(record, documentUri)) {
        return undefined;
    }

    const startedAt = typeof record.startedAt === 'string'
        ? record.startedAt
        : new Date(0).toISOString();
    return {
        ...record,
        version: 1,
        queueRunId: getQueueRunId(record, documentUri),
        taskFilePath: documentUri.fsPath,
        commandId: record.commandId as AutoTaskQueueCommandId,
        status: record.status as AutoTaskQueueStatus,
        startedAt,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : startedAt
    };
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

async function readAutoTaskQueueLock(lockUri: vscode.Uri): Promise<AutoTaskQueueLockRecord | undefined> {
    try {
        const content = await vscode.workspace.fs.readFile(lockUri);
        const parsed = JSON.parse(Buffer.from(content).toString()) as Partial<AutoTaskQueueLockRecord>;
        if (typeof parsed.owner === 'string' && typeof parsed.createdAt === 'string') {
            return {
                owner: parsed.owner,
                createdAt: parsed.createdAt
            };
        }

        return {
            owner: 'invalid',
            createdAt: new Date(0).toISOString()
        };
    } catch {
        return undefined;
    }
}

async function deleteAutoTaskQueueLock(lockUri: vscode.Uri): Promise<void> {
    try {
        await vscode.workspace.fs.delete(lockUri);
    } catch {
        // Another extension host may have already released the advisory lock.
    }
}

function isAutoTaskQueueLockStale(record: AutoTaskQueueLockRecord, now = Date.now()): boolean {
    const createdAt = Date.parse(record.createdAt);
    return !Number.isFinite(createdAt) || now - createdAt > AUTO_TASK_QUEUE_LOCK_STALE_MS;
}

function summarizeAutoTaskQueueLock(
    lockPath: string,
    record: AutoTaskQueueLockRecord | undefined,
    now: number
): AutoTaskQueueLockSummary {
    if (!record) {
        return {
            path: lockPath,
            status: 'absent'
        };
    }

    const createdAt = Date.parse(record.createdAt);
    const ageMs = Number.isFinite(createdAt)
        ? Math.max(0, now - createdAt)
        : undefined;
    return {
        path: lockPath,
        status: isAutoTaskQueueLockStale(record, now) ? 'stale' : 'active',
        owner: record.owner,
        createdAt: record.createdAt,
        ageMs
    };
}

function getQueueRunId(record: Partial<AutoTaskQueueRecord>, documentUri: vscode.Uri): string {
    if (typeof record.queueRunId === 'string' && record.queueRunId.trim()) {
        return record.queueRunId;
    }

    return createLegacyQueueRunId(record, documentUri);
}

function createQueueRunId(): string {
    return `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createLegacyQueueRunId(record: Partial<AutoTaskQueueRecord>, documentUri: vscode.Uri): string {
    return `legacy-${hashString([
        documentUri.fsPath,
        record.commandId ?? '',
        record.startedAt ?? '',
        record.updatedAt ?? ''
    ].join('|'))}`;
}

function hashString(value: string): string {
    let hash = 0;
    for (let index = 0; index < value.length; index++) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }

    return (hash >>> 0).toString(36);
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
