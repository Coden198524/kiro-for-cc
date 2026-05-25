import * as vscode from 'vscode';
import { SpecManager } from '../features/spec/specManager';
import { TaskCompletionService } from '../features/spec/taskCompletionService';
import { TaskSessionManager } from '../features/spec/taskSessionManager';
import { markRunnableTasksInProgress, readTaskLine, updateTaskLineStatus } from '../features/spec/taskStatusEditor';
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

            const run = await specManager.implTask(documentUri.fsPath, effectiveDescription, shouldResume, lineNumber);
            if (run?.terminal) {
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
            }
        }),
        vscode.commands.registerCommand('autocode.spec.implAllTasks', async (documentUri: vscode.Uri) => {
            outputChannel.appendLine(`[Task Execute] Starting all tasks: ${documentUri.fsPath}`);

            const run = await specManager.implAllTasks(documentUri.fsPath);
            if (run?.terminal && run.completionSignalPaths) {
                await markRunnableTasksInProgress(documentUri);
                taskCompletionService.registerTaskCompletionSignals(context, run.terminal, documentUri.fsPath, run.completionSignalPaths);
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
