import * as vscode from 'vscode';
import { SpecManager, TaskImplementationRun } from '../features/spec/specManager';
import { TaskCompletionService } from '../features/spec/taskCompletionService';
import { TaskSessionManager } from '../features/spec/taskSessionManager';
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

    const registerAutoTaskContinuation = (
        documentUri: vscode.Uri,
        run: TaskImplementationRun | undefined,
        commandId: 'autocode.spec.implAllTasks' | 'autocode.spec.implAllTasksParallel'
    ): void => {
        if (!run?.terminal || !run.completionSignalPath || run.lineNumber === undefined || !run.taskDescription) {
            return;
        }

        const completion = taskCompletionService.registerTaskCompletion(
            context,
            run.terminal,
            {
                taskFilePath: documentUri.fsPath,
                lineNumber: run.lineNumber,
                taskDescription: run.taskDescription
            },
            run.completionSignalPath
        );

        if (!completion) {
            outputChannel.appendLine('[Task Execute] Auto task queue will not continue because automatic task verification is disabled.');
            return;
        }

        completion.then(async verified => {
            if (verified) {
                await vscode.commands.executeCommand(commandId, documentUri);
            }
        }).catch(error => {
            outputChannel.appendLine(`[Task Execute] Failed to continue auto task queue: ${error}`);
        });
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

                taskCompletionService.registerTaskCompletion(
                    context,
                    run.terminal,
                    {
                        taskFilePath: documentUri.fsPath,
                        lineNumber,
                        taskDescription: effectiveDescription
                    },
                    run.completionSignalPath
                );
            } catch (error) {
                await markTaskLinesPending(documentUri, changedLineNumbers);
                outputChannel.appendLine(`[Task Execute] Failed to start task on line ${lineNumber + 1}: ${error}`);
                vscode.window.showErrorMessage(`Failed to start task: ${error}`);
            }
        }),
        vscode.commands.registerCommand('autocode.spec.implAllTasks', async (documentUri: vscode.Uri) => {
            outputChannel.appendLine(`[Task Execute] Starting auto task queue: ${documentUri.fsPath}`);

            const changedLineNumbers: number[] = [];
            try {
                const run = await specManager.implAllTasks(documentUri.fsPath, {
                    beforeLaunchTasks: async tasks => {
                        changedLineNumbers.push(...await markTaskLinesInProgress(documentUri, tasks.map(task => task.lineNumber)));
                    }
                });
                if (run?.failedLineNumbers?.length) {
                    await markTaskLinesPending(documentUri, run.failedLineNumbers);
                }

                if (run?.terminal && run.completionSignalPaths) {
                    taskCompletionService.registerTaskCompletionSignals(context, run.terminal, documentUri.fsPath, run.completionSignalPaths);
                    return;
                }

                registerAutoTaskContinuation(documentUri, run, 'autocode.spec.implAllTasks');
            } catch (error) {
                await markTaskLinesPending(documentUri, changedLineNumbers);
                outputChannel.appendLine(`[Task Execute] Failed to start auto task queue: ${error}`);
                vscode.window.showErrorMessage(`Failed to start auto task queue: ${error}`);
            }
        }),
        vscode.commands.registerCommand('autocode.spec.implAllTasksParallel', async (documentUri: vscode.Uri) => {
            outputChannel.appendLine(`[Task Execute] Starting parallel tasks: ${documentUri.fsPath}`);

            const changedLineNumbers: number[] = [];
            try {
                const run = await specManager.implAllTasksParallel(documentUri.fsPath, {
                    beforeLaunchTasks: async tasks => {
                        changedLineNumbers.push(...await markTaskLinesInProgress(documentUri, tasks.map(task => task.lineNumber)));
                    }
                });
                if (run?.failedLineNumbers?.length) {
                    await markTaskLinesPending(documentUri, run.failedLineNumbers);
                    vscode.window.showWarningMessage(`${run.failedLineNumbers.length} parallel task(s) failed to start and were returned to pending.`);
                }

                if (run?.parallelRuns?.length) {
                    const completionResults = run.parallelRuns
                        .map(parallelRun => taskCompletionService.registerTaskCompletion(
                        context,
                        parallelRun.terminal,
                        {
                            taskFilePath: parallelRun.taskFilePath,
                            lineNumber: parallelRun.lineNumber,
                            taskDescription: parallelRun.taskDescription
                        },
                        parallelRun.completionSignalPath
                        ))
                        .filter((result): result is Promise<boolean> => Boolean(result));

                    if (completionResults.length > 0 && !run.failedLineNumbers?.length) {
                        Promise.all(completionResults).then(async results => {
                            if (results.every(Boolean)) {
                                await vscode.commands.executeCommand('autocode.spec.implAllTasksParallel', documentUri);
                            }
                        }).catch(error => {
                            outputChannel.appendLine(`[Task Execute] Failed to continue parallel task batch: ${error}`);
                        });
                    }
                    return;
                }

                if (run?.terminal && run.completionSignalPaths) {
                    taskCompletionService.registerTaskCompletionSignals(context, run.terminal, documentUri.fsPath, run.completionSignalPaths);
                    return;
                }

                registerAutoTaskContinuation(documentUri, run, 'autocode.spec.implAllTasksParallel');
            } catch (error) {
                await markTaskLinesPending(documentUri, changedLineNumbers);
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
