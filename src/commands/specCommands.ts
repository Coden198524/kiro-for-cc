import * as vscode from 'vscode';
import { SpecManager, TaskImplementationRun } from '../features/spec/specManager';
import { TaskCompletionService } from '../features/spec/taskCompletionService';
import { AutoTaskQueueCommandId, TaskQueueController } from '../features/spec/taskQueueController';
import { TaskSessionManager } from '../features/spec/taskSessionManager';
import { hasChildSpecTasks, parseSpecTaskLine } from '../features/spec/taskStatus';
import { markTaskLinesInProgress, markTaskLinesPending, readTaskLine, updateTaskLineStatus } from '../features/spec/taskStatusEditor';
import { SpecExplorerProvider } from '../providers/specExplorerProvider';

export interface RegisterSpecCommandsOptions {
    context: vscode.ExtensionContext;
    specManager: SpecManager;
    specExplorer: SpecExplorerProvider;
    taskSessionManager: TaskSessionManager;
    taskCompletionService: TaskCompletionService;
    outputChannel: vscode.OutputChannel;
}

export function registerSpecCommands(options: RegisterSpecCommandsOptions): void {
    const {
        context,
        specManager,
        specExplorer,
        taskSessionManager,
        taskCompletionService,
        outputChannel
    } = options;

    const taskQueueController = new TaskQueueController(outputChannel);
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

        const queuedLineNumbers = getQueuedLineNumbers(record);
        if (queuedLineNumbers.length > 0) {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'AutoCode is checking queued task completion signals...',
                    cancellable: false
                },
                () => taskCompletionService.reconcileTaskCompletionSignals(activeDocumentUri.fsPath, { lineNumbers: queuedLineNumbers })
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
        try {
            const document = await vscode.workspace.openTextDocument(documentUri);
            const lines: string[] = [];
            for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
                lines.push(document.lineAt(lineNumber).text);
            }

            const lineNumbers: number[] = [];
            for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
                const task = parseSpecTaskLine(lines[lineNumber]);
                if (task?.status === 'inProgress' && !hasChildSpecTasks(lines, lineNumber)) {
                    lineNumbers.push(lineNumber);
                }
            }

            return lineNumbers;
        } catch (error) {
            outputChannel.appendLine(`[Task Execute] Failed to inspect in-progress tasks before queue start: ${error}`);
            return [];
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
                await taskQueueController.start(documentUri, commandId);
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
                await taskQueueController.start(documentUri, commandId);
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
        vscode.commands.registerCommand('autocode.spec.resumeTaskQueue', resumeAutoTaskQueue),
        vscode.commands.registerCommand('autocode.spec.clearTaskQueue', clearAutoTaskQueue),
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
}
