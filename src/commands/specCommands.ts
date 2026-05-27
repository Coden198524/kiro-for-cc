import * as vscode from 'vscode';
import { SpecManager } from '../features/spec/specManager';
import { TaskCompletionService } from '../features/spec/taskCompletionService';
import {
    AutoTaskQueueCommandId,
    AutoTaskQueueDiagnostics,
    AutoTaskQueueRecoveryRecord,
    AutoTaskQueueStartBlockedError,
    findRecoverableAutoTaskQueues,
    getAutoTaskQueueDiagnostics,
    getAutoTaskQueueSummary,
    isAutoTaskQueueStale,
    TaskQueueController
} from '../features/spec/taskQueueController';
import { AutoTaskQueueRunner } from '../features/spec/autoTaskQueueRunner';
import { FinalVerificationManager } from '../features/spec/finalVerificationManager';
import { TaskQueueRecoveryInspector } from '../features/spec/taskQueueRecovery';
import { TaskSessionManager } from '../features/spec/taskSessionManager';
import { markTaskLinesInProgress, markTaskLinesPending, readTaskLine, updateTaskLineStatus } from '../features/spec/taskStatusEditor';
import { MemoryManager } from '../features/memory/memoryManager';
import { CurrentWorkProvider } from '../providers/currentWorkProvider';
import { SpecExplorerProvider } from '../providers/specExplorerProvider';

export interface RegisterSpecCommandsOptions {
    context: vscode.ExtensionContext;
    specManager: SpecManager;
    specExplorer: SpecExplorerProvider;
    taskSessionManager: TaskSessionManager;
    taskCompletionService: TaskCompletionService;
    memoryManager?: MemoryManager;
    currentWorkProvider?: CurrentWorkProvider;
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
        memoryManager,
        currentWorkProvider,
        outputChannel,
        recoverTaskQueuesOnStartup = false
    } = options;

    const taskQueueController = new TaskQueueController(outputChannel);
    const taskQueueRecovery = new TaskQueueRecoveryInspector(taskQueueController, outputChannel);
    const taskQueueRunner = new AutoTaskQueueRunner({
        context,
        taskQueueController,
        taskCompletionService,
        recoveryInspector: taskQueueRecovery,
        outputChannel
    });
    const finalVerificationManager = new FinalVerificationManager(outputChannel, memoryManager);
    const refreshQueueViews = (): void => {
        specExplorer.refresh();
        currentWorkProvider?.refresh();
    };

    const resolveTasksDocumentUri = (documentUri?: vscode.Uri | { resourceUri?: vscode.Uri }): vscode.Uri | undefined => {
        const argumentUri = isUriLike(documentUri)
            ? documentUri
            : isUriLike(documentUri?.resourceUri)
                ? documentUri.resourceUri
                : undefined;
        const activeDocumentUri = argumentUri ?? vscode.window.activeTextEditor?.document.uri;
        if (!activeDocumentUri || !activeDocumentUri.fsPath.endsWith('tasks.md')) {
            vscode.window.showWarningMessage('Open a spec tasks.md file before managing the auto task queue.');
            return undefined;
        }

        return activeDocumentUri;
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
            refreshQueueViews();
            return;
        }

        const inspection = await taskQueueRecovery.inspectQueuedTasks(activeDocumentUri, record);
        if (inspection.unresolvedTasks.length > 0) {
            await taskQueueController.pause(
                activeDocumentUri,
                record.commandId,
                `${inspection.unresolvedTasks.length} queued task(s) could not be found in tasks.md.`
            );
            refreshQueueViews();
            vscode.window.showWarningMessage('Auto task queue paused because one or more queued tasks could not be found after tasks.md changed. Open tasks.md and resolve the queue manually.');
            return;
        }

        if (inspection.drifted) {
            outputChannel.appendLine('[Task Queue] Updated queued task line numbers after detecting tasks.md edits.');
        }

        if (inspection.resolvedTasks.length > 0 && inspection.pendingLineNumbers.length === 0) {
            await taskQueueController.clear(activeDocumentUri);
            outputChannel.appendLine('[Task Execute] Queued task(s) are already completed; continuing with the next task.');
            refreshQueueViews();
            await vscode.commands.executeCommand(record.commandId, activeDocumentUri);
            return;
        }

        if (record.status === 'waiting_for_signal' && isAutoTaskQueueStale(record)) {
            await taskQueueController.pause(
                activeDocumentUri,
                record.commandId,
                'Queue waited too long for completion signal.'
            );
            refreshQueueViews();
            vscode.window.showWarningMessage('Auto task queue paused because it waited too long for a completion signal. Review the task terminal, then resume or cancel the queue.');
            return;
        }

        const queuedTasks = inspection.resolvedTasks.length > 0
            ? inspection.resolvedTasks.map(task => ({
                ...task.original,
                lineNumber: task.lineNumber,
                taskDescription: task.taskDescription
            }))
            : taskQueueRecovery.getQueuedTasks(record);
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
                    expectedRunIdsByLineNumber: taskQueueRecovery.getExpectedRunIdsByLineNumber(queuedTasks),
                    taskLineNumbersBySignalLineNumber: taskQueueRecovery.getTaskLineNumbersBySignalLineNumber(inspection.resolvedTasks),
                    minModifiedAt: Number.isFinite(startedAt) ? startedAt - 2000 : undefined
                })
            );
            if (result.verified >= queuedLineNumbers.length) {
            await taskQueueController.clear(activeDocumentUri);
            outputChannel.appendLine(`[Task Execute] Resuming auto task queue after reconciling ${result.verified}/${result.detected} completion signal(s).`);
            refreshQueueViews();
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
            refreshQueueViews();
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
        refreshQueueViews();
        vscode.window.showInformationMessage('Auto task queue state cleared for this spec.');
    };

    const showTaskQueueDetails = async (documentUri?: vscode.Uri): Promise<void> => {
        const activeDocumentUri = resolveTasksDocumentUri(documentUri);
        if (!activeDocumentUri) {
            return;
        }

        const diagnostics = await getAutoTaskQueueDiagnostics(activeDocumentUri);
        const document = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: formatAutoTaskQueueDiagnostics(diagnostics)
        });
        await vscode.window.showTextDocument(document);
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

        const inspection = await taskQueueRecovery.inspectQueuedTasks(activeDocumentUri, record);
        const queuedLineNumbers = inspection.resolvedTasks.length > 0
            ? inspection.resolvedTasks.map(task => task.lineNumber)
            : taskQueueRecovery.getQueuedLineNumbers(record);
        await markTaskLinesPending(activeDocumentUri, queuedLineNumbers);
        await taskQueueController.clear(activeDocumentUri);
        refreshQueueViews();
        vscode.window.showInformationMessage('Auto task queue cancelled. Queued in-progress tasks were returned to pending when possible.');
    };

    const startAutoTaskQueue = async (
        documentUri: vscode.Uri,
        commandId: AutoTaskQueueCommandId
    ): Promise<boolean> => {
        try {
            await taskQueueController.start(documentUri, commandId);
            refreshQueueViews();
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
                'Details',
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
                refreshQueueViews();
                return true;
            }

            if (action === 'Open Tasks') {
                const document = await vscode.workspace.openTextDocument(documentUri);
                await vscode.window.showTextDocument(document);
                return false;
            }

            if (action === 'Details') {
                await showTaskQueueDetails(documentUri);
                return false;
            }

            if (action === 'Cancel Queue') {
                await cancelAutoTaskQueue(documentUri);
                return false;
            }

            if (action === 'Clear') {
                await taskQueueController.clear(documentUri);
                refreshQueueViews();
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
            'Details',
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

        if (action === 'Details') {
            await showTaskQueueDetails(selectedQueue.documentUri);
            return;
        }

        if (action === 'Cancel') {
            await cancelAutoTaskQueue(selectedQueue.documentUri);
            return;
        }

        if (action === 'Clear') {
            await taskQueueController.clear(selectedQueue.documentUri);
            refreshQueueViews();
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
        const lineNumbers = await taskQueueRecovery.readInProgressLeafTaskLineNumbers(documentUri);
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
                    refreshQueueViews();
                }

                if (run && await taskQueueRunner.registerBatchTaskContinuation(documentUri, run, commandId)) {
                    return;
                }

                await taskQueueRunner.registerAutoTaskContinuation(documentUri, run, commandId);
            } catch (error) {
                await markTaskLinesPending(documentUri, changedLineNumbers);
                await taskQueueController.pause(documentUri, commandId, `Failed to start auto task queue: ${error}`, changedLineNumbers);
                refreshQueueViews();
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
                const continuationCommandId: AutoTaskQueueCommandId = run?.fallbackToSequential
                    ? 'autocode.spec.implAllTasks'
                    : commandId;
                const failedStartLineNumbers = run?.failedLineNumbers ?? [];
                if (failedStartLineNumbers.length > 0) {
                    await markTaskLinesPending(documentUri, failedStartLineNumbers);
                    vscode.window.showWarningMessage(`${failedStartLineNumbers.length} parallel task(s) failed to start and were returned to pending.`);
                    if (!run?.parallelRuns?.length) {
                        await taskQueueController.pause(documentUri, commandId, `${failedStartLineNumbers.length} parallel task(s) failed to start.`, failedStartLineNumbers);
                        refreshQueueViews();
                        return;
                    }
                }

                if (run?.parallelRuns?.length) {
                    const batchTasks = run.parallelRuns.map(parallelRun => ({
                        lineNumber: parallelRun.lineNumber,
                        taskDescription: parallelRun.taskDescription,
                        completionSignalPath: parallelRun.completionSignalPath,
                        completionSignalToken: parallelRun.completionSignalToken
                    }));
                    const queueRecord = await taskQueueController.waitForBatch(documentUri, commandId, batchTasks);
                    refreshQueueViews();
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

                    if (completionResults.length !== run.parallelRuns.length) {
                        const monitoredLineNumbers = new Set(completionResults.map(result => result.lineNumber));
                        const unmonitoredLineNumbers = run.parallelRuns
                            .map(parallelRun => parallelRun.lineNumber)
                            .filter(lineNumber => !monitoredLineNumbers.has(lineNumber));
                        for (const result of completionResults) {
                            result.completion.catch(error => {
                                outputChannel.appendLine(`[Task Execute] Parallel task verification failed after queue pause on line ${result.lineNumber + 1}: ${error}`);
                            });
                        }
                        await markTaskLinesPending(documentUri, unmonitoredLineNumbers);
                        await taskQueueController.pause(documentUri, commandId, 'Automatic parallel task verification is disabled for one or more launched tasks.', unmonitoredLineNumbers);
                        refreshQueueViews();
                        vscode.window.showWarningMessage('Auto task queue paused because automatic parallel task verification is disabled for one or more launched tasks.');
                        return;
                    }

                    Promise.all(completionResults.map(result => result.completion)).then(async results => {
                        if (!await taskQueueController.getMatchingBatchQueue(documentUri, batchTasks, commandId, queueRecord.queueRunId)) {
                            return;
                        }

                        const failedLineNumbers = completionResults
                            .filter((_result, index) => !results[index])
                            .map(result => result.lineNumber);
                        if (failedLineNumbers.length > 0) {
                            await markTaskLinesPending(documentUri, failedLineNumbers);
                            vscode.window.showWarningMessage(`${failedLineNumbers.length} parallel task(s) were not verified as complete and were returned to pending.`);
                            await taskQueueController.pause(documentUri, commandId, `${failedLineNumbers.length} parallel task(s) were not verified as complete.`, failedLineNumbers);
                            refreshQueueViews();
                            return;
                        }

                        if (results.every(Boolean)) {
                            if (failedStartLineNumbers.length > 0) {
                                await taskQueueController.pause(
                                    documentUri,
                                    commandId,
                                    `${failedStartLineNumbers.length} parallel task(s) failed to start; launched task(s) were verified.`,
                                    failedStartLineNumbers
                                );
                                refreshQueueViews();
                                vscode.window.showWarningMessage('Auto task queue paused after launched parallel tasks completed because one or more tasks failed to start.');
                                return;
                            }

                            await taskQueueController.clear(documentUri);
                            refreshQueueViews();
                            await vscode.commands.executeCommand(commandId, documentUri);
                        }
                    }).catch(error => {
                        outputChannel.appendLine(`[Task Execute] Failed to continue parallel task batch: ${error}`);
                        taskQueueController.pause(documentUri, commandId, `Failed to continue parallel batch: ${error}`).catch(queueError => {
                            outputChannel.appendLine(`[Task Queue] Failed to pause parallel queue state: ${queueError}`);
                        });
                    });
                    return;
                }

                if (run && await taskQueueRunner.registerBatchTaskContinuation(documentUri, run, continuationCommandId)) {
                    return;
                }

                await taskQueueRunner.registerAutoTaskContinuation(documentUri, run, continuationCommandId);
            } catch (error) {
                await markTaskLinesPending(documentUri, changedLineNumbers);
                await taskQueueController.pause(documentUri, commandId, `Failed to start parallel tasks: ${error}`, changedLineNumbers);
                refreshQueueViews();
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
        vscode.commands.registerCommand('autocode.spec.runFinalVerification', async (documentUri?: vscode.Uri) => {
            const activeDocumentUri = resolveTasksDocumentUri(documentUri);
            if (!activeDocumentUri) {
                return;
            }

            await finalVerificationManager.run(activeDocumentUri);
        }),
        vscode.commands.registerCommand('autocode.spec.showTaskQueues', showTaskQueues),
        vscode.commands.registerCommand('autocode.spec.resumeTaskQueue', resumeAutoTaskQueue),
        vscode.commands.registerCommand('autocode.spec.showTaskQueueDetails', showTaskQueueDetails),
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
            refreshQueueViews();
            vscode.window.showInformationMessage(`Task marked done: ${task.description}`);
            if (!await taskQueueRunner.continueAutoTaskQueue(documentUri, lineNumber, 'manual Mark Done')) {
                await taskQueueRunner.continueBatchAutoTaskQueueIfReady(documentUri, lineNumber, 'manual Mark Done');
            }
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

function isUriLike(value: unknown): value is vscode.Uri {
    return Boolean(value && typeof (value as vscode.Uri).fsPath === 'string');
}

function formatAutoTaskQueueDiagnostics(diagnostics: AutoTaskQueueDiagnostics): string {
    const lines = [
        '# Auto Task Queue Details',
        '',
        `- Task file: ${diagnostics.taskFilePath}`,
        `- State file: ${diagnostics.statePath}`,
        `- Lock file: ${diagnostics.lock.path}`,
        ''
    ];

    if (!diagnostics.record || !diagnostics.summary) {
        lines.push('## Queue', '', 'No persisted auto task queue was found.', '');
    } else {
        const record = diagnostics.record;
        lines.push(...[
            '## Queue',
            '',
            `- Run ID: ${record.queueRunId}`,
            `- Command: ${record.commandId}`,
            `- Status: ${diagnostics.summary.statusText}`,
            `- Started: ${record.startedAt}`,
            `- Updated: ${record.updatedAt}`,
            `- Stale: ${diagnostics.summary.stale ? 'yes' : 'no'}`,
            record.pauseReason ? `- Pause reason: ${record.pauseReason}` : undefined,
            record.lastEvent ? `- Last event: ${record.lastEvent}` : undefined,
            ''
        ].filter((line): line is string => line !== undefined));

        const queuedTasks = [
            ...(record.currentTask ? [{ type: 'current', ...record.currentTask }] : []),
            ...(record.batchTasks ?? []).map(task => ({ type: 'batch', ...task }))
        ];
        if (queuedTasks.length > 0) {
            lines.push(
                '## Queued Tasks',
                '',
                '| Type | Line | Description | Signal | Run Token |',
                '| --- | ---: | --- | --- | --- |'
            );
            for (const task of queuedTasks) {
                lines.push(`| ${task.type} | ${task.lineNumber + 1} | ${escapeMarkdownTableCell(task.taskDescription)} | ${escapeMarkdownTableCell(task.completionSignalPath ?? '')} | ${escapeMarkdownTableCell(task.completionSignalToken ?? '')} |`);
            }
            lines.push('');
        }
    }

    lines.push(...[
        '## Lock',
        '',
        `- Status: ${diagnostics.lock.status}`,
        diagnostics.lock.owner ? `- Owner: ${diagnostics.lock.owner}` : undefined,
        diagnostics.lock.createdAt ? `- Created: ${diagnostics.lock.createdAt}` : undefined,
        diagnostics.lock.ageMs !== undefined ? `- Age: ${Math.round(diagnostics.lock.ageMs / 1000)}s` : undefined,
        ''
    ].filter((line): line is string => line !== undefined));

    return lines.join('\n');
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
