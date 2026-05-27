import * as vscode from 'vscode';
import { TaskCompletionService } from './taskCompletionService';
import type { TaskImplementationRun } from './specManager';
import {
    AutoTaskQueueCommandId,
    AutoTaskQueueTaskState,
    TaskQueueController
} from './taskQueueController';
import { TaskQueueRecoveryInspector } from './taskQueueRecovery';
import { markTaskLinesPending } from './taskStatusEditor';

export interface AutoTaskQueueRunnerOptions {
    context: vscode.ExtensionContext;
    taskQueueController: TaskQueueController;
    taskCompletionService: TaskCompletionService;
    recoveryInspector: TaskQueueRecoveryInspector;
    outputChannel: vscode.OutputChannel;
}

export class AutoTaskQueueRunner {
    constructor(private options: AutoTaskQueueRunnerOptions) { }

    async continueAutoTaskQueue(
        documentUri: vscode.Uri,
        lineNumber: number,
        source: string
    ): Promise<boolean> {
        const commandId = await this.options.taskQueueController.consumeContinuation(documentUri, lineNumber, source);
        if (!commandId) {
            return false;
        }

        this.options.outputChannel.appendLine(`[Task Execute] Auto task queue continuing after ${source} on line ${lineNumber + 1}.`);
        await vscode.commands.executeCommand(commandId, documentUri);
        return true;
    }

    async continueBatchAutoTaskQueueIfReady(
        documentUri: vscode.Uri,
        lineNumber: number,
        source: string
    ): Promise<boolean> {
        const record = await this.options.taskQueueController.get(documentUri);
        if (!record?.batchTasks?.some(task => task.lineNumber === lineNumber)) {
            return false;
        }

        const inspection = await this.options.recoveryInspector.inspectQueuedTasks(documentUri, record);
        if (inspection.unresolvedTasks.length > 0 || inspection.resolvedTasks.length === 0 || inspection.pendingLineNumbers.length > 0) {
            return false;
        }

        await this.options.taskQueueController.clear(documentUri);
        this.options.outputChannel.appendLine(`[Task Execute] Auto task queue continuing after ${source}; all queued batch tasks are completed.`);
        await vscode.commands.executeCommand(record.commandId, documentUri);
        return true;
    }

    async registerAutoTaskContinuation(
        documentUri: vscode.Uri,
        run: TaskImplementationRun | undefined,
        commandId: AutoTaskQueueCommandId
    ): Promise<void> {
        const { context, taskCompletionService, taskQueueController, outputChannel } = this.options;
        if (!run?.terminal || !run.completionSignalPath || run.lineNumber === undefined || !run.taskDescription) {
            await taskQueueController.complete(documentUri, commandId, 'No task run was registered for continuation.');
            return;
        }

        const queueRecord = await taskQueueController.waitForTask(documentUri, commandId, {
            lineNumber: run.lineNumber,
            taskDescription: run.taskDescription,
            completionSignalPath: run.completionSignalPath,
            completionSignalToken: run.completionSignalToken
        });

        const completion = taskCompletionService.registerTaskCompletion(
            context,
            run.terminal,
            {
                taskFilePath: documentUri.fsPath,
                lineNumber: run.lineNumber,
                taskDescription: run.taskDescription
            },
            run.completionSignalPath,
            run.completionSignalToken
        );

        if (!completion) {
            outputChannel.appendLine('[Task Execute] Auto task queue will not continue because automatic task verification is disabled.');
            await taskQueueController.pause(documentUri, commandId, 'Automatic task verification is disabled.', [run.lineNumber]);
            return;
        }

        completion.then(async verified => {
            if (!await taskQueueController.getMatchingQueue(documentUri, run.lineNumber!, commandId, queueRecord.queueRunId)) {
                return;
            }

            if (verified) {
                outputChannel.appendLine(`[Task Execute] Auto task queue verified line ${run.lineNumber! + 1}; continuing with the next task.`);
                await this.continueAutoTaskQueue(documentUri, run.lineNumber!, 'automatic verification');
                return;
            }

            await markTaskLinesPending(documentUri, [run.lineNumber!]);
            await taskQueueController.pause(documentUri, commandId, 'Current task was not verified as complete.', [run.lineNumber!]);
            vscode.window.showWarningMessage('Auto task queue paused because the current task was not verified as complete. Mark the task done manually to continue the queue.');
        }).catch(error => {
            outputChannel.appendLine(`[Task Execute] Failed to continue auto task queue: ${error}`);
            taskQueueController.pause(documentUri, commandId, `Failed to continue queue: ${error}`, [run.lineNumber!]).catch(queueError => {
                outputChannel.appendLine(`[Task Queue] Failed to pause queue state: ${queueError}`);
            });
        });
    }

    async registerBatchTaskContinuation(
        documentUri: vscode.Uri,
        run: TaskImplementationRun,
        commandId: AutoTaskQueueCommandId
    ): Promise<boolean> {
        const { context, taskCompletionService, taskQueueController, outputChannel } = this.options;
        if (!run.terminal || run.completionSignalPath || !run.completionSignalPaths?.length) {
            return false;
        }

        const batchTasks: AutoTaskQueueTaskState[] = run.completionSignalPaths.map((signalPath, index) => ({
            lineNumber: this.options.recoveryInspector.parseCompletionSignalLineNumber(signalPath) ?? index,
            taskDescription: `Batch task ${index + 1}`,
            completionSignalPath: signalPath,
            completionSignalToken: run.completionSignalTokens?.[index]
        }));
        const queueRecord = await taskQueueController.waitForBatch(documentUri, commandId, batchTasks);

        const expectedRunIdsBySignalPath = this.getExpectedRunIdsBySignalPath(batchTasks);
        const completion = Object.keys(expectedRunIdsBySignalPath).length > 0
            ? taskCompletionService.registerTaskCompletionSignals(context, run.terminal, documentUri.fsPath, run.completionSignalPaths, {
                expectedRunIdsBySignalPath
            })
            : taskCompletionService.registerTaskCompletionSignals(context, run.terminal, documentUri.fsPath, run.completionSignalPaths);
        if (!completion) {
            outputChannel.appendLine('[Task Execute] Auto task queue will not continue because automatic batch task verification is disabled.');
            await taskQueueController.pause(documentUri, commandId, 'Automatic batch task verification is disabled.', batchTasks.map(task => task.lineNumber));
            return true;
        }

        completion.then(async verified => {
            if (!await taskQueueController.getMatchingBatchQueue(documentUri, batchTasks, commandId, queueRecord.queueRunId)) {
                return;
            }

            if (verified) {
                outputChannel.appendLine('[Task Execute] Batch completion verified; continuing with the next task.');
                await taskQueueController.clear(documentUri);
                await vscode.commands.executeCommand(commandId, documentUri);
                return;
            }

            await markTaskLinesPending(documentUri, batchTasks.map(task => task.lineNumber));
            await taskQueueController.pause(documentUri, commandId, 'One or more batch tasks were not verified as complete.', batchTasks.map(task => task.lineNumber));
            vscode.window.showWarningMessage('Auto task queue paused because one or more batch tasks were not verified as complete.');
        }).catch(error => {
            outputChannel.appendLine(`[Task Execute] Failed to continue auto task queue after batch verification: ${error}`);
            taskQueueController.pause(documentUri, commandId, `Failed to continue queue after batch verification: ${error}`, batchTasks.map(task => task.lineNumber)).catch(queueError => {
                outputChannel.appendLine(`[Task Queue] Failed to pause batch queue state: ${queueError}`);
            });
        });

        return true;
    }

    private getExpectedRunIdsBySignalPath(tasks: readonly AutoTaskQueueTaskState[]): Record<string, string> {
        const expectedRunIdsBySignalPath: Record<string, string> = {};
        for (const task of tasks) {
            if (task.completionSignalPath && task.completionSignalToken) {
                expectedRunIdsBySignalPath[task.completionSignalPath] = task.completionSignalToken;
            }
        }

        return expectedRunIdsBySignalPath;
    }
}
