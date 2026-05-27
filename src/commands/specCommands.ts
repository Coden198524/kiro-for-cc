import * as vscode from 'vscode';
import { SpecManager, TaskImplementationRun } from '../features/spec/specManager';
import { TaskCompletionService } from '../features/spec/taskCompletionService';
import {
    AutoTaskQueueCommandId,
    AutoTaskQueueRecord,
    AutoTaskQueueRecoveryRecord,
    AutoTaskQueueStartBlockedError,
    AutoTaskQueueTaskState,
    findRecoverableAutoTaskQueues,
    getAutoTaskQueueSummary,
    isAutoTaskQueueStale,
    TaskQueueController
} from '../features/spec/taskQueueController';
import { TaskSessionManager } from '../features/spec/taskSessionManager';
import { hasChildSpecTasks, parseSpecTaskLine, SpecTaskStatus } from '../features/spec/taskStatus';
import { markTaskLinesInProgress, markTaskLinesPending, readTaskLine, updateTaskLineStatus } from '../features/spec/taskStatusEditor';
import { SpecExplorerProvider } from '../providers/specExplorerProvider';

export interface RegisterSpecCommandsOptions {
    context: vscode.ExtensionContext;
    specManager: SpecManager;
    specExplorer: SpecExplorerProvider;
    taskSessionManager: TaskSessionManager;
    taskCompletionService: TaskCompletionService;
    outputChannel: vscode.OutputChannel;
    recoverTaskQueuesOnStartup?: boolean;
}

export function registerSpecCommands(options: RegisterSpecCommandsOptions): void {
    const {
        context,
        specManager,
        specExplorer,
        taskSessionManager,
        taskCompletionService,
        outputChannel,
        recoverTaskQueuesOnStartup = false
    } = options;

    const taskQueueController = new TaskQueueController(outputChannel);
    interface ResolvedQueuedTask {
        original: AutoTaskQueueTaskState;
        lineNumber: number;
        taskDescription: string;
        status?: SpecTaskStatus;
        drifted: boolean;
    }

    interface QueueRecoveryInspection {
        resolvedTasks: ResolvedQueuedTask[];
        unresolvedTasks: AutoTaskQueueTaskState[];
        completedLineNumbers: number[];
        pendingLineNumbers: number[];
        drifted: boolean;
    }

    const continueAutoTaskQueue = async (
        documentUri: vscode.Uri,
        lineNumber: number,
        source: string
    ): Promise<boolean> => {
        const commandId = await taskQueueController.consumeContinuation(documentUri, lineNumber, source);
        if (!commandId) {
            return false;
        }

        outputChannel.appendLine(`[Task Execute] Auto task queue continuing after ${source} on line ${lineNumber + 1}.`);
        await vscode.commands.executeCommand(commandId, documentUri);
        return true;
    };

    const registerAutoTaskContinuation = async (
        documentUri: vscode.Uri,
        run: TaskImplementationRun | undefined,
        commandId: AutoTaskQueueCommandId
    ): Promise<void> => {
        if (!run?.terminal || !run.completionSignalPath || run.lineNumber === undefined || !run.taskDescription) {
            await taskQueueController.complete(documentUri, commandId, 'No task run was registered for continuation.');
            return;
        }

        await taskQueueController.waitForTask(documentUri, commandId, {
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
            if (!await taskQueueController.getMatchingQueue(documentUri, run.lineNumber!, commandId)) {
                return;
            }

            if (verified) {
                outputChannel.appendLine(`[Task Execute] Auto task queue verified line ${run.lineNumber! + 1}; continuing with the next task.`);
                await continueAutoTaskQueue(documentUri, run.lineNumber!, 'automatic verification');
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
    };

    const registerBatchTaskContinuation = async (
        documentUri: vscode.Uri,
        run: TaskImplementationRun,
        commandId: AutoTaskQueueCommandId
    ): Promise<boolean> => {
        if (!run.terminal || run.completionSignalPath || !run.completionSignalPaths?.length) {
            return false;
        }

        await taskQueueController.waitForBatch(documentUri, commandId, run.completionSignalPaths.map((signalPath, index) => ({
            lineNumber: parseCompletionSignalLineNumber(signalPath) ?? index,
            taskDescription: `Batch task ${index + 1}`,
            completionSignalPath: signalPath
        })));

        const completion = taskCompletionService.registerTaskCompletionSignals(context, run.terminal, documentUri.fsPath, run.completionSignalPaths);
        if (!completion) {
            outputChannel.appendLine('[Task Execute] Auto task queue will not continue because automatic batch task verification is disabled.');
            await taskQueueController.pause(documentUri, commandId, 'Automatic batch task verification is disabled.');
            return true;
        }

        completion.then(async verified => {
            if (verified) {
                outputChannel.appendLine('[Task Execute] Batch completion verified; continuing with the next task.');
                await taskQueueController.clear(documentUri);
                await vscode.commands.executeCommand(commandId, documentUri);
                return;
            }

            await taskQueueController.pause(documentUri, commandId, 'One or more batch tasks were not verified as complete.');
            vscode.window.showWarningMessage('Auto task queue paused because one or more batch tasks were not verified as complete.');
        }).catch(error => {
            outputChannel.appendLine(`[Task Execute] Failed to continue auto task queue after batch verification: ${error}`);
            taskQueueController.pause(documentUri, commandId, `Failed to continue queue after batch verification: ${error}`).catch(queueError => {
                outputChannel.appendLine(`[Task Queue] Failed to pause batch queue state: ${queueError}`);
            });
        });

        return true;
    };

    const parseCompletionSignalLineNumber = (completionSignalPath: string): number | undefined => {
        const match = completionSignalPath.replace(/\\/g, '/').match(/task-completion-(\d+)\.json$/);
        return match ? Number(match[1]) - 1 : undefined;
    };

    const resolveTasksDocumentUri = (documentUri?: vscode.Uri): vscode.Uri | undefined => {
        const activeDocumentUri = documentUri ?? vscode.window.activeTextEditor?.document.uri;
        if (!activeDocumentUri || !activeDocumentUri.fsPath.endsWith('tasks.md')) {
            vscode.window.showWarningMessage('Open a spec tasks.md file before managing the auto task queue.');
            return undefined;
        }

        return activeDocumentUri;
    };

    const getQueuedLineNumbers = (record: Awaited<ReturnType<TaskQueueController['get']>>): number[] => {
        if (!record) {
            return [];
        }

        const lineNumbers = new Set<number>();
        if (record.currentTask) {
            lineNumbers.add(record.currentTask.lineNumber);
        }

        for (const task of record.batchTasks ?? []) {
            lineNumbers.add(task.lineNumber);
        }

        return [...lineNumbers].filter(lineNumber => Number.isInteger(lineNumber) && lineNumber >= 0);
    };

    const getExpectedRunIdsByLineNumber = (tasks: readonly AutoTaskQueueTaskState[]): Record<number, string | undefined> => {
        return tasks.reduce<Record<number, string | undefined>>((result, task) => {
            result[task.lineNumber] = task.completionSignalToken;
            return result;
        }, {});
    };

    const getTaskLineNumbersBySignalLineNumber = (
        resolvedTasks: readonly ResolvedQueuedTask[]
    ): Record<number, number | undefined> | undefined => {
        const result: Record<number, number | undefined> = {};
        for (const resolvedTask of resolvedTasks) {
            const signalLineNumber = resolvedTask.original.completionSignalPath
                ? parseCompletionSignalLineNumber(resolvedTask.original.completionSignalPath)
                : resolvedTask.original.lineNumber;
            if (signalLineNumber !== undefined && signalLineNumber !== resolvedTask.lineNumber) {
                result[signalLineNumber] = resolvedTask.lineNumber;
            }
        }

        return Object.keys(result).length > 0 ? result : undefined;
    };

    const getQueuedTasks = (record: AutoTaskQueueRecord): AutoTaskQueueTaskState[] => [
        ...(record.currentTask ? [record.currentTask] : []),
        ...(record.batchTasks ?? [])
    ];

    const readDocumentLinesSafely = async (documentUri: vscode.Uri, context: string): Promise<string[] | undefined> => {
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
            outputChannel.appendLine(`[${context}] Failed to read ${documentUri.fsPath}: ${error}`);
            return undefined;
        }
    };

    const inspectQueuedTasks = async (
        documentUri: vscode.Uri,
        record: AutoTaskQueueRecord
    ): Promise<QueueRecoveryInspection> => {
        const queuedTasks = getQueuedTasks(record);
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

        const lines = await readDocumentLinesSafely(documentUri, 'Task Queue');
        if (!lines) {
            inspection.pendingLineNumbers = queuedTasks.map(task => task.lineNumber);
            return inspection;
        }

        for (const queuedTask of queuedTasks) {
            const resolved = resolveQueuedTaskLine(lines, queuedTask);
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
            await taskQueueController.updateQueuedTasks(documentUri, record.commandId, {
                currentTask: record.currentTask
                    ? remapQueuedTask(record.currentTask, inspection.resolvedTasks)
                    : undefined,
                batchTasks: record.batchTasks
                    ?.map(task => remapQueuedTask(task, inspection.resolvedTasks))
                    .filter((task): task is AutoTaskQueueTaskState => Boolean(task)),
                event: 'Queued task line numbers were refreshed after tasks.md changed.'
            });
        }

        return inspection;
    };

    const resolveQueuedTaskLine = (
        lines: readonly string[],
        queuedTask: AutoTaskQueueTaskState
    ): ResolvedQueuedTask | undefined => {
        const originalTask = readTaskFromLines(lines, queuedTask.lineNumber);
        if (originalTask && taskDescriptionsMatch(originalTask.description, queuedTask.taskDescription)) {
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
            if (task && taskDescriptionsMatch(task.description, queuedTask.taskDescription)) {
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
    };

    const readTaskFromLines = (lines: readonly string[], lineNumber: number): ReturnType<typeof parseSpecTaskLine> => {
        if (lineNumber < 0 || lineNumber >= lines.length) {
            return undefined;
        }

        return parseSpecTaskLine(lines[lineNumber]);
    };

    const taskDescriptionsMatch = (left: string, right: string): boolean =>
        normalizeTaskDescription(left) === normalizeTaskDescription(right);

    const normalizeTaskDescription = (value: string): string =>
        value.replace(/\s+/g, ' ').trim();

    const remapQueuedTask = (
        task: AutoTaskQueueTaskState,
        resolvedTasks: readonly ResolvedQueuedTask[]
    ): AutoTaskQueueTaskState | undefined => {
        const resolved = resolvedTasks.find(candidate => candidate.original === task);
        if (!resolved) {
            return undefined;
        }

        return {
            ...task,
            lineNumber: resolved.lineNumber,
            taskDescription: resolved.taskDescription
        };
    };

    const resumeAutoTaskQueue = async (documentUri?: vscode.Uri): Promise<void> => {
        const activeDocumentUri = resolveTasksDocumentUri(documentUri);
        if (!activeDocumentUri) {
            return;
        }

        const record = await taskQueueController.get(activeDocumentUri);
        if (!record) {
            vscode.window.showInformationMessage('No auto task queue state was found for this spec.');
            return;
        }

        if (record.status === 'completed') {
            await taskQueueController.clear(activeDocumentUri);
            vscode.window.showInformationMessage('Auto task queue is already completed.');
            return;
        }

        const inspection = await inspectQueuedTasks(activeDocumentUri, record);
        if (inspection.unresolvedTasks.length > 0) {
            await taskQueueController.pause(
                activeDocumentUri,
                record.commandId,
                `${inspection.unresolvedTasks.length} queued task(s) could not be found in tasks.md.`
            );
            vscode.window.showWarningMessage('Auto task queue paused because one or more queued tasks could not be found after tasks.md changed. Open tasks.md and resolve the queue manually.');
            return;
        }

        if (inspection.drifted) {
            outputChannel.appendLine('[Task Queue] Updated queued task line numbers after detecting tasks.md edits.');
        }

        if (inspection.resolvedTasks.length > 0 && inspection.pendingLineNumbers.length === 0) {
            await taskQueueController.clear(activeDocumentUri);
            outputChannel.appendLine('[Task Execute] Queued task(s) are already completed; continuing with the next task.');
            await vscode.commands.executeCommand(record.commandId, activeDocumentUri);
            return;
        }

        if (record.status === 'waiting_for_signal' && isAutoTaskQueueStale(record)) {
            await taskQueueController.pause(
                activeDocumentUri,
                record.commandId,
                'Queue waited too long for completion signal.'
            );
            vscode.window.showWarningMessage('Auto task queue paused because it waited too long for a completion signal. Review the task terminal, then resume or cancel the queue.');
            return;
        }

        const queuedTasks = inspection.resolvedTasks.length > 0
            ? inspection.resolvedTasks.map(task => ({
                ...task.original,
                lineNumber: task.lineNumber,
                taskDescription: task.taskDescription
            }))
            : getQueuedTasks(record);
        const queuedLineNumbers = queuedTasks.map(task => task.lineNumber);
        if (queuedLineNumbers.length > 0) {
            const startedAt = Date.parse(record.startedAt);
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'AutoCode is checking queued task completion signals...',
                    cancellable: false
                },
                () => taskCompletionService.reconcileTaskCompletionSignals(activeDocumentUri.fsPath, {
                    lineNumbers: queuedLineNumbers,
                    expectedRunIdsByLineNumber: getExpectedRunIdsByLineNumber(queuedTasks),
                    taskLineNumbersBySignalLineNumber: getTaskLineNumbersBySignalLineNumber(inspection.resolvedTasks),
                    minModifiedAt: Number.isFinite(startedAt) ? startedAt - 2000 : undefined
                })
            );
            if (result.verified >= queuedLineNumbers.length) {
                await taskQueueController.clear(activeDocumentUri);
                outputChannel.appendLine(`[Task Execute] Resuming auto task queue after reconciling ${result.verified}/${result.detected} completion signal(s).`);
                await vscode.commands.executeCommand(record.commandId, activeDocumentUri);
                return;
            }

            if (record.status === 'waiting_for_signal') {
                vscode.window.showWarningMessage(`Auto task queue is still waiting for ${queuedLineNumbers.length} queued task(s) to finish. Mark the current task done or run reconciliation again after completion.`);
                return;
            }
        }

        if (record.status === 'paused') {
            await taskQueueController.clear(activeDocumentUri);
            outputChannel.appendLine(`[Task Execute] Resuming paused auto task queue: ${record.pauseReason ?? record.lastEvent ?? 'no pause reason recorded'}`);
            await vscode.commands.executeCommand(record.commandId, activeDocumentUri);
            return;
        }

        vscode.window.showInformationMessage(`Auto task queue status is ${record.status}; no resume action was taken.`);
    };

    const clearAutoTaskQueue = async (documentUri?: vscode.Uri): Promise<void> => {
        const activeDocumentUri = resolveTasksDocumentUri(documentUri);
        if (!activeDocumentUri) {
            return;
        }

        await taskQueueController.clear(activeDocumentUri);
        vscode.window.showInformationMessage('Auto task queue state cleared for this spec.');
    };

    const cancelAutoTaskQueue = async (documentUri?: vscode.Uri): Promise<void> => {
        const activeDocumentUri = resolveTasksDocumentUri(documentUri);
        if (!activeDocumentUri) {
            return;
        }

        const record = await taskQueueController.get(activeDocumentUri);
        if (!record || record.status === 'completed') {
            vscode.window.showInformationMessage('No active auto task queue was found for this spec.');
            return;
        }

        const inspection = await inspectQueuedTasks(activeDocumentUri, record);
        const queuedLineNumbers = inspection.resolvedTasks.length > 0
            ? inspection.resolvedTasks.map(task => task.lineNumber)
            : getQueuedLineNumbers(record);
        await markTaskLinesPending(activeDocumentUri, queuedLineNumbers);
        await taskQueueController.clear(activeDocumentUri);
        vscode.window.showInformationMessage('Auto task queue cancelled. Queued in-progress tasks were returned to pending when possible.');
    };

    const startAutoTaskQueue = async (
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId
    ): Promise<boolean> => {
        try {
            await taskQueueController.start(documentUri, commandId);
            return true;
        } catch (error) {
            if (!(error instanceof AutoTaskQueueStartBlockedError)) {
                throw error;
            }

            const summary = getAutoTaskQueueSummary(error.record);
            const action = await vscode.window.showWarningMessage(
                [
                    `An auto task queue is already ${summary.statusText}.`,
                    summary.currentTaskDescription ? `Current: ${summary.currentTaskDescription}.` : '',
                    summary.stale ? 'It appears stale.' : '',
                    'Choose how to proceed.'
                ].filter(Boolean).join(' '),
                'Resume',
                'Start New',
                'Open Tasks',
                'Cancel Queue',
                'Clear'
            );

            if (action === 'Resume') {
                await resumeAutoTaskQueue(documentUri);
                return false;
            }

            if (action === 'Start New') {
                await cancelAutoTaskQueue(documentUri);
                await taskQueueController.start(documentUri, commandId, { force: true });
                return true;
            }

            if (action === 'Open Tasks') {
                const document = await vscode.workspace.openTextDocument(documentUri);
                await vscode.window.showTextDocument(document);
                return false;
            }

            if (action === 'Cancel Queue') {
                await cancelAutoTaskQueue(documentUri);
                return false;
            }

            if (action === 'Clear') {
                await taskQueueController.clear(documentUri);
                vscode.window.showInformationMessage('Auto task queue state cleared for this spec.');
            }

            return false;
        }
    };

    const findRecoverableQueues = async (): Promise<AutoTaskQueueRecoveryRecord[]> => {
        const specBasePath = await specManager.getSpecBasePath();
        return findRecoverableAutoTaskQueues(vscode.workspace.workspaceFolders, specBasePath);
    };

    const showTaskQueues = async (): Promise<void> => {
        const queues = await findRecoverableQueues();
        if (queues.length === 0) {
            vscode.window.showInformationMessage('No interrupted auto task queues were found.');
            return;
        }

        const selectedQueue = await selectRecoverableQueue(queues);
        if (!selectedQueue) {
            return;
        }

        const action = await vscode.window.showInformationMessage(
            `Auto task queue for ${selectedQueue.specName} is ${formatQueueStatus(selectedQueue.record.status)}.`,
            'Resume',
            'Open Tasks',
            'Cancel',
            'Clear'
        );

        if (action === 'Resume') {
            await resumeAutoTaskQueue(selectedQueue.documentUri);
            return;
        }

        if (action === 'Open Tasks') {
            const document = await vscode.workspace.openTextDocument(selectedQueue.documentUri);
            await vscode.window.showTextDocument(document);
            return;
        }

        if (action === 'Cancel') {
            await cancelAutoTaskQueue(selectedQueue.documentUri);
            return;
        }

        if (action === 'Clear') {
            await taskQueueController.clear(selectedQueue.documentUri);
            vscode.window.showInformationMessage(`Auto task queue cleared for ${selectedQueue.specName}.`);
        }
    };

    const selectRecoverableQueue = async (
        queues: AutoTaskQueueRecoveryRecord[]
    ): Promise<AutoTaskQueueRecoveryRecord | undefined> => {
        if (queues.length === 1) {
            return queues[0];
        }

        const items = queues.map(queue => ({
            label: queue.specName,
            description: formatQueueStatus(queue.record.status),
            detail: `${queue.workspaceFolderName} - ${queue.record.lastEvent ?? queue.record.pauseReason ?? queue.record.taskFilePath}`,
            queue
        }));
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select an interrupted AutoCode task queue'
        });

        return selected?.queue;
    };

    const notifyRecoverableTaskQueuesOnStartup = async (): Promise<void> => {
        const queues = await findRecoverableQueues();
        if (queues.length === 0) {
            return;
        }

        const message = queues.length === 1
            ? `AutoCode found an interrupted auto task queue for ${queues[0].specName}.`
            : `AutoCode found ${queues.length} interrupted auto task queues.`;
        const choice = await vscode.window.showInformationMessage(message, 'Review', 'Later');
        if (choice === 'Review') {
            await vscode.commands.executeCommand('autocode.spec.showTaskQueues');
        }
    };

    const reconcileExistingCompletionsBeforeQueue = async (documentUri: vscode.Uri): Promise<void> => {
        const lineNumbers = await readInProgressLeafTaskLineNumbers(documentUri);
        if (lineNumbers.length === 0) {
            return;
        }

        outputChannel.appendLine(`[Task Execute] Checking completion signal(s) for ${lineNumbers.length} in-progress task(s) before starting the queue.`);
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'AutoCode is checking existing task completion signals...',
                cancellable: false
            },
            () => taskCompletionService.reconcileTaskCompletionSignals(documentUri.fsPath, { lineNumbers })
        );
        if (result?.verified) {
            outputChannel.appendLine(`[Task Execute] Reconciled ${result.verified}/${result.detected} existing completion signal(s) before starting the task queue.`);
        }
    };

    const readInProgressLeafTaskLineNumbers = async (documentUri: vscode.Uri): Promise<number[]> => {
        const lines = await readDocumentLinesSafely(documentUri, 'Task Execute');
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
    };

    const createSpecCommand = vscode.commands.registerCommand('autocode.spec.create', async () => {
        outputChannel.appendLine('\n=== COMMAND autocode.spec.create TRIGGERED ===');
        outputChannel.appendLine(`Time: ${new Date().toLocaleTimeString()}`);

        try {
            await specManager.create();
        } catch (error) {
            outputChannel.appendLine(`Error in createNewSpec: ${error}`);
            vscode.window.showErrorMessage(`Failed to create spec: ${error}`);
        }
    });

    const createSpecWithAgentsCommand = vscode.commands.registerCommand('autocode.spec.createWithAgents', async () => {
        try {
            await specManager.createWithAgents();
        } catch (error) {
            outputChannel.appendLine(`Error in createWithAgents: ${error}`);
            vscode.window.showErrorMessage(`Failed to create spec with agents: ${error}`);
        }
    });

    context.subscriptions.push(
        createSpecCommand,
        createSpecWithAgentsCommand,
        vscode.commands.registerCommand('autocode.spec.navigate.requirements', async (specName: string) => {
            await specManager.navigateToDocument(specName, 'requirements');
        }),
        vscode.commands.registerCommand('autocode.spec.navigate.design', async (specName: string) => {
            await specManager.navigateToDocument(specName, 'design');
        }),
        vscode.commands.registerCommand('autocode.spec.navigate.tasks', async (specName: string) => {
            await specManager.navigateToDocument(specName, 'tasks');
        }),
        vscode.commands.registerCommand('autocode.spec.implTask', async (documentUri: vscode.Uri, lineNumber: number, taskDescription: string, resume = false) => {
            outputChannel.appendLine(`[Task Execute] Line ${lineNumber + 1}: ${taskDescription}`);

            const result = await updateTaskLineStatus(documentUri, lineNumber, 'inProgress');
            const task = result?.task;
            if (task?.status === 'completed') {
                vscode.window.showInformationMessage(`Task is already completed: ${task.description}`);
                return;
            }

            const effectiveDescription = task?.description || taskDescription;
            const shouldResume = resume || task?.status === 'inProgress';
            const changedLineNumbers = result?.changedLineNumbers ?? [];

            try {
                const run = await specManager.implTask(documentUri.fsPath, effectiveDescription, shouldResume, lineNumber);
                if (!run?.terminal) {
                    await markTaskLinesPending(documentUri, changedLineNumbers);
                    return;
                }

                const completion = taskCompletionService.registerTaskCompletion(
                    context,
                    run.terminal,
                    {
                        taskFilePath: documentUri.fsPath,
                        lineNumber,
                        taskDescription: effectiveDescription
                    },
                    run.completionSignalPath,
                    run.completionSignalToken
                );
                completion?.then(async verified => {
                    if (!verified) {
                        await markTaskLinesPending(documentUri, changedLineNumbers.length > 0 ? changedLineNumbers : [lineNumber]);
                    }
                }).catch(error => {
                    outputChannel.appendLine(`[Task Execute] Failed to process task completion result on line ${lineNumber + 1}: ${error}`);
                });
            } catch (error) {
                await markTaskLinesPending(documentUri, changedLineNumbers);
                outputChannel.appendLine(`[Task Execute] Failed to start task on line ${lineNumber + 1}: ${error}`);
                vscode.window.showErrorMessage(`Failed to start task: ${error}`);
            }
        }),
        vscode.commands.registerCommand('autocode.spec.implAllTasks', async (documentUri: vscode.Uri) => {
            outputChannel.appendLine(`[Task Execute] Starting auto task queue: ${documentUri.fsPath}`);

            const changedLineNumbers: number[] = [];
            const commandId: AutoTaskQueueCommandId = 'autocode.spec.implAllTasks';
            try {
                if (!await startAutoTaskQueue(documentUri, commandId)) {
                    return;
                }
                await reconcileExistingCompletionsBeforeQueue(documentUri);
                const run = await specManager.implAllTasks(documentUri.fsPath, {
                    beforeLaunchTasks: async tasks => {
                        changedLineNumbers.push(...await markTaskLinesInProgress(documentUri, tasks.map(task => task.lineNumber)));
                    }
                });
                if (run?.failedLineNumbers?.length) {
                    await markTaskLinesPending(documentUri, run.failedLineNumbers);
                    await taskQueueController.pause(documentUri, commandId, `${run.failedLineNumbers.length} task(s) failed to start.`, run.failedLineNumbers);
                }

                if (run && await registerBatchTaskContinuation(documentUri, run, commandId)) {
                    return;
                }

                await registerAutoTaskContinuation(documentUri, run, commandId);
            } catch (error) {
                await markTaskLinesPending(documentUri, changedLineNumbers);
                await taskQueueController.pause(documentUri, commandId, `Failed to start auto task queue: ${error}`, changedLineNumbers);
                outputChannel.appendLine(`[Task Execute] Failed to start auto task queue: ${error}`);
                vscode.window.showErrorMessage(`Failed to start auto task queue: ${error}`);
            }
        }),
        vscode.commands.registerCommand('autocode.spec.implAllTasksParallel', async (documentUri: vscode.Uri) => {
            outputChannel.appendLine(`[Task Execute] Starting parallel tasks: ${documentUri.fsPath}`);

            const changedLineNumbers: number[] = [];
            const commandId: AutoTaskQueueCommandId = 'autocode.spec.implAllTasksParallel';
            try {
                if (!await startAutoTaskQueue(documentUri, commandId)) {
                    return;
                }
                await reconcileExistingCompletionsBeforeQueue(documentUri);
                const run = await specManager.implAllTasksParallel(documentUri.fsPath, {
                    beforeLaunchTasks: async tasks => {
                        changedLineNumbers.push(...await markTaskLinesInProgress(documentUri, tasks.map(task => task.lineNumber)));
                    }
                });
                if (run?.failedLineNumbers?.length) {
                    await markTaskLinesPending(documentUri, run.failedLineNumbers);
                    await taskQueueController.pause(documentUri, commandId, `${run.failedLineNumbers.length} parallel task(s) failed to start.`, run.failedLineNumbers);
                    vscode.window.showWarningMessage(`${run.failedLineNumbers.length} parallel task(s) failed to start and were returned to pending.`);
                }

                if (run?.parallelRuns?.length) {
                    await taskQueueController.waitForBatch(documentUri, commandId, run.parallelRuns.map(parallelRun => ({
                        lineNumber: parallelRun.lineNumber,
                        taskDescription: parallelRun.taskDescription,
                        completionSignalPath: parallelRun.completionSignalPath,
                        completionSignalToken: parallelRun.completionSignalToken
                    })));
                    const completionResults = run.parallelRuns
                        .map(parallelRun => ({
                            lineNumber: parallelRun.lineNumber,
                            completion: taskCompletionService.registerTaskCompletion(
                                context,
                                parallelRun.terminal,
                                {
                                    taskFilePath: parallelRun.taskFilePath,
                                    lineNumber: parallelRun.lineNumber,
                                    taskDescription: parallelRun.taskDescription
                                },
                                parallelRun.completionSignalPath,
                                parallelRun.completionSignalToken
                            )
                        }))
                        .filter((result): result is { lineNumber: number; completion: Promise<boolean> } => Boolean(result.completion));

                    if (completionResults.length === 0) {
                        await taskQueueController.pause(documentUri, commandId, 'Automatic parallel task verification is disabled.');
                        vscode.window.showWarningMessage('Auto task queue paused because automatic parallel task verification is disabled.');
                        return;
                    }

                    if (completionResults.length > 0 && !run.failedLineNumbers?.length) {
                        Promise.all(completionResults.map(result => result.completion)).then(async results => {
                            const failedLineNumbers = completionResults
                                .filter((_result, index) => !results[index])
                                .map(result => result.lineNumber);
                            if (failedLineNumbers.length > 0) {
                                await markTaskLinesPending(documentUri, failedLineNumbers);
                                await taskQueueController.pause(documentUri, commandId, `${failedLineNumbers.length} parallel task(s) were not verified as complete.`, failedLineNumbers);
                                vscode.window.showWarningMessage(`${failedLineNumbers.length} parallel task(s) were not verified as complete and were returned to pending.`);
                                return;
                            }

                            if (results.every(Boolean)) {
                                await taskQueueController.clear(documentUri);
                                await vscode.commands.executeCommand(commandId, documentUri);
                            }
                        }).catch(error => {
                            outputChannel.appendLine(`[Task Execute] Failed to continue parallel task batch: ${error}`);
                            taskQueueController.pause(documentUri, commandId, `Failed to continue parallel batch: ${error}`).catch(queueError => {
                                outputChannel.appendLine(`[Task Queue] Failed to pause parallel queue state: ${queueError}`);
                            });
                        });
                    }
                    return;
                }

                if (run && await registerBatchTaskContinuation(documentUri, run, commandId)) {
                    return;
                }

                await registerAutoTaskContinuation(documentUri, run, commandId);
            } catch (error) {
                await markTaskLinesPending(documentUri, changedLineNumbers);
                await taskQueueController.pause(documentUri, commandId, `Failed to start parallel tasks: ${error}`, changedLineNumbers);
                outputChannel.appendLine(`[Task Execute] Failed to start parallel tasks: ${error}`);
                vscode.window.showErrorMessage(`Failed to start parallel tasks: ${error}`);
            }
        }),
        vscode.commands.registerCommand('autocode.spec.reconcileTaskCompletions', async (documentUri?: vscode.Uri) => {
            const activeDocumentUri = documentUri ?? vscode.window.activeTextEditor?.document.uri;
            if (!activeDocumentUri || !activeDocumentUri.fsPath.endsWith('tasks.md')) {
                vscode.window.showWarningMessage('Open a spec tasks.md file before reconciling task completions.');
                return;
            }

            const result = await taskCompletionService.reconcileTaskCompletionSignals(activeDocumentUri.fsPath);
            vscode.window.showInformationMessage(`Task completion reconciliation finished: ${result.verified}/${result.detected} verified.`);
        }),
        vscode.commands.registerCommand('autocode.spec.showTaskQueues', showTaskQueues),
        vscode.commands.registerCommand('autocode.spec.resumeTaskQueue', resumeAutoTaskQueue),
        vscode.commands.registerCommand('autocode.spec.clearTaskQueue', clearAutoTaskQueue),
        vscode.commands.registerCommand('autocode.spec.cancelTaskQueue', cancelAutoTaskQueue),
        vscode.commands.registerCommand('autocode.spec.markTaskDone', async (documentUri: vscode.Uri, lineNumber: number) => {
            outputChannel.appendLine(`[Task Complete] Line ${lineNumber + 1}`);

            const result = await updateTaskLineStatus(documentUri, lineNumber, 'completed');
            const task = result?.task;
            if (!task) {
                vscode.window.showWarningMessage('Could not find a task checkbox on the selected line.');
                return;
            }

            await taskSessionManager.markCompleted(documentUri.fsPath, lineNumber, task.description);
            for (const parent of result.parentTasks) {
                await taskSessionManager.markCompleted(documentUri.fsPath, parent.lineNumber, parent.description);
            }
            vscode.window.showInformationMessage(`Task marked done: ${task.description}`);
            await continueAutoTaskQueue(documentUri, lineNumber, 'manual Mark Done');
        }),
        vscode.commands.registerCommand('autocode.spec.viewTaskSession', async (documentUri: vscode.Uri, lineNumber: number, taskDescription?: string) => {
            outputChannel.appendLine(`[Task Session] Line ${lineNumber + 1}`);

            const task = await readTaskLine(documentUri, lineNumber);
            const effectiveDescription = task?.description || taskDescription;
            if (!effectiveDescription) {
                vscode.window.showWarningMessage('Could not find a task checkbox on the selected line.');
                return;
            }

            await taskSessionManager.showSession(documentUri.fsPath, lineNumber, effectiveDescription);
        }),
        vscode.commands.registerCommand('autocode.spec.refresh', async () => {
            outputChannel.appendLine('[Manual Refresh] Refreshing spec explorer...');
            specExplorer.refresh();
        }),
        vscode.commands.registerCommand('autocode.spec.delete', async (item: { label: string }) => {
            await specManager.delete(item.label);
        })
    );

    if (recoverTaskQueuesOnStartup) {
        notifyRecoverableTaskQueuesOnStartup().catch(error => {
            outputChannel.appendLine(`[Task Queue] Failed to inspect recoverable queues on startup: ${error}`);
        });
    }
}

function formatQueueStatus(status: string): string {
    return status.replace(/_/g, ' ');
}
