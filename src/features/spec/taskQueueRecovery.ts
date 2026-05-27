import * as vscode from 'vscode';
import {
    AutoTaskQueueRecord,
    AutoTaskQueueTaskState,
    TaskQueueController
} from './taskQueueController';
import { hasChildSpecTasks, parseSpecTaskLine, SpecTaskStatus } from './taskStatus';

export interface ResolvedQueuedTask {
    original: AutoTaskQueueTaskState;
    lineNumber: number;
    taskDescription: string;
    status?: SpecTaskStatus;
    drifted: boolean;
}

export interface QueueRecoveryInspection {
    resolvedTasks: ResolvedQueuedTask[];
    unresolvedTasks: AutoTaskQueueTaskState[];
    completedLineNumbers: number[];
    pendingLineNumbers: number[];
    drifted: boolean;
}

export class TaskQueueRecoveryInspector {
    constructor(
        private taskQueueController: Pick<TaskQueueController, 'updateQueuedTasks'>,
        private outputChannel: vscode.OutputChannel
    ) { }

    parseCompletionSignalLineNumber(completionSignalPath: string): number | undefined {
        const match = completionSignalPath.replace(/\\/g, '/').match(/task-completion-(\d+)\.json$/);
        return match ? Number(match[1]) - 1 : undefined;
    }

    getQueuedTasks(record: AutoTaskQueueRecord): AutoTaskQueueTaskState[] {
        return [
            ...(record.currentTask ? [record.currentTask] : []),
            ...(record.batchTasks ?? [])
        ];
    }

    getQueuedLineNumbers(record: AutoTaskQueueRecord | undefined): number[] {
        if (!record) {
            return [];
        }

        const lineNumbers = new Set<number>();
        for (const task of this.getQueuedTasks(record)) {
            lineNumbers.add(task.lineNumber);
        }

        return [...lineNumbers].filter(lineNumber => Number.isInteger(lineNumber) && lineNumber >= 0);
    }

    getExpectedRunIdsByLineNumber(tasks: readonly AutoTaskQueueTaskState[]): Record<number, string | undefined> {
        return tasks.reduce<Record<number, string | undefined>>((result, task) => {
            result[task.lineNumber] = task.completionSignalToken;
            return result;
        }, {});
    }

    getTaskLineNumbersBySignalLineNumber(
        resolvedTasks: readonly ResolvedQueuedTask[]
    ): Record<number, number | undefined> | undefined {
        const result: Record<number, number | undefined> = {};
        for (const resolvedTask of resolvedTasks) {
            const signalLineNumber = resolvedTask.original.completionSignalPath
                ? this.parseCompletionSignalLineNumber(resolvedTask.original.completionSignalPath)
                : resolvedTask.original.lineNumber;
            if (signalLineNumber !== undefined && signalLineNumber !== resolvedTask.lineNumber) {
                result[signalLineNumber] = resolvedTask.lineNumber;
            }
        }

        return Object.keys(result).length > 0 ? result : undefined;
    }

    async inspectQueuedTasks(
        documentUri: vscode.Uri,
        record: AutoTaskQueueRecord
    ): Promise<QueueRecoveryInspection> {
        const queuedTasks = this.getQueuedTasks(record);
        const inspection: QueueRecoveryInspection = {
            resolvedTasks: [],
            unresolvedTasks: [],
            completedLineNumbers: [],
            pendingLineNumbers: [],
            drifted: false
        };

        if (queuedTasks.length === 0) {
            return inspection;
        }

        const lines = await this.readDocumentLinesSafely(documentUri, 'Task Queue');
        if (!lines) {
            inspection.pendingLineNumbers = queuedTasks.map(task => task.lineNumber);
            return inspection;
        }

        for (const queuedTask of queuedTasks) {
            const resolved = this.resolveQueuedTaskLine(lines, queuedTask);
            if (!resolved) {
                inspection.unresolvedTasks.push(queuedTask);
                continue;
            }

            inspection.resolvedTasks.push(resolved);
            if (resolved.drifted) {
                inspection.drifted = true;
            }

            if (resolved.status === 'completed') {
                inspection.completedLineNumbers.push(resolved.lineNumber);
            } else {
                inspection.pendingLineNumbers.push(resolved.lineNumber);
            }
        }

        if (inspection.drifted && inspection.unresolvedTasks.length === 0) {
            await this.taskQueueController.updateQueuedTasks(documentUri, record.commandId, {
                currentTask: record.currentTask
                    ? this.remapQueuedTask(record.currentTask, inspection.resolvedTasks)
                    : undefined,
                batchTasks: record.batchTasks
                    ?.map(task => this.remapQueuedTask(task, inspection.resolvedTasks))
                    .filter((task): task is AutoTaskQueueTaskState => Boolean(task)),
                event: 'Queued task line numbers were refreshed after tasks.md changed.'
            });
        }

        return inspection;
    }

    async readInProgressLeafTaskLineNumbers(documentUri: vscode.Uri): Promise<number[]> {
        const lines = await this.readDocumentLinesSafely(documentUri, 'Task Execute');
        if (!lines) {
            return [];
        }

        const lineNumbers: number[] = [];
        for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            const task = parseSpecTaskLine(lines[lineNumber]);
            if (task?.status === 'inProgress' && !hasChildSpecTasks(lines, lineNumber)) {
                lineNumbers.push(lineNumber);
            }
        }

        return lineNumbers;
    }

    private async readDocumentLinesSafely(documentUri: vscode.Uri, context: string): Promise<string[] | undefined> {
        try {
            const document = await vscode.workspace.openTextDocument(documentUri);
            if (!document || typeof document.lineCount !== 'number' || typeof document.lineAt !== 'function') {
                throw new Error('VS Code did not return a valid text document.');
            }

            const lines: string[] = [];
            for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
                lines.push(document.lineAt(lineNumber).text);
            }

            return lines;
        } catch (error) {
            this.outputChannel.appendLine(`[${context}] Failed to read ${documentUri.fsPath}: ${error}`);
            return undefined;
        }
    }

    private resolveQueuedTaskLine(
        lines: readonly string[],
        queuedTask: AutoTaskQueueTaskState
    ): ResolvedQueuedTask | undefined {
        const originalTask = this.readTaskFromLines(lines, queuedTask.lineNumber);
        if (originalTask && this.taskDescriptionsMatch(originalTask.description, queuedTask.taskDescription)) {
            return {
                original: queuedTask,
                lineNumber: queuedTask.lineNumber,
                taskDescription: originalTask.description,
                status: originalTask.status,
                drifted: false
            };
        }

        for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            const task = parseSpecTaskLine(lines[lineNumber]);
            if (task && this.taskDescriptionsMatch(task.description, queuedTask.taskDescription)) {
                return {
                    original: queuedTask,
                    lineNumber,
                    taskDescription: task.description,
                    status: task.status,
                    drifted: lineNumber !== queuedTask.lineNumber
                };
            }
        }

        return undefined;
    }

    private readTaskFromLines(lines: readonly string[], lineNumber: number): ReturnType<typeof parseSpecTaskLine> {
        if (lineNumber < 0 || lineNumber >= lines.length) {
            return undefined;
        }

        return parseSpecTaskLine(lines[lineNumber]);
    }

    private taskDescriptionsMatch(left: string, right: string): boolean {
        return this.normalizeTaskDescription(left) === this.normalizeTaskDescription(right);
    }

    private normalizeTaskDescription(value: string): string {
        return value.replace(/\s+/g, ' ').trim();
    }

    private remapQueuedTask(
        task: AutoTaskQueueTaskState,
        resolvedTasks: readonly ResolvedQueuedTask[]
    ): AutoTaskQueueTaskState | undefined {
        const resolved = resolvedTasks.find(candidate => candidate.original === task);
        if (!resolved) {
            return undefined;
        }

        return {
            ...task,
            lineNumber: resolved.lineNumber,
            taskDescription: resolved.taskDescription
        };
    }
}
