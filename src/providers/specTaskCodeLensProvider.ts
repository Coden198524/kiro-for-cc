import * as vscode from 'vscode';
import { getAutoTaskQueueSummary, readAutoTaskQueueRecord } from '../features/spec/taskQueueController';
import { hasChildSpecTasks, parseSpecTaskLine } from '../features/spec/taskStatus';
import { ConfigManager } from '../utils/configManager';

export class SpecTaskCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
    private configManager: ConfigManager;

    constructor() {
        this.configManager = ConfigManager.getInstance();
        this.configManager.loadSettings();
        vscode.workspace.onDidChangeConfiguration((_) => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    public async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        const specDir = this.configManager.getPath('specs');
        const normalizedSpecDir = specDir.replace(/\\/g, '/');
        const normalizedFileName = document.fileName.replace(/\\/g, '/');

        const specDirSegment = `/${normalizedSpecDir}/`;
        if (!normalizedFileName.includes(specDirSegment) || !normalizedFileName.endsWith('tasks.md')) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];
        const lines = document.getText().split(/\r?\n/);
        const queueRecord = await readAutoTaskQueueRecord(document.uri);
        if (queueRecord && queueRecord.status !== 'completed') {
            const summary = getAutoTaskQueueSummary(queueRecord);
            const title = queueRecord.status === 'waiting_for_signal'
                ? 'Check Auto Queue'
                : 'Resume Auto Queue';
            codeLenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: `${title} (${summary.statusText}, ${summary.taskCount} task${summary.taskCount === 1 ? '' : 's'}${summary.stale ? ', stale' : ''})`,
                tooltip: [
                    queueRecord.pauseReason || queueRecord.lastEvent || 'Resume or reconcile the persisted auto task queue',
                    summary.currentTaskDescription ? `Current: ${summary.currentTaskDescription}` : undefined
                ].filter(Boolean).join('\n'),
                command: 'autocode.spec.resumeTaskQueue',
                arguments: [document.uri]
            }));
            codeLenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: 'Cancel Auto Queue',
                tooltip: 'Cancel the persisted auto task queue and return queued in-progress tasks to pending when possible',
                command: 'autocode.spec.cancelTaskQueue',
                arguments: [document.uri]
            }));
            codeLenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: 'Clear Auto Queue',
                tooltip: 'Clear the persisted auto task queue state for this spec',
                command: 'autocode.spec.clearTaskQueue',
                arguments: [document.uri]
            }));
        }

        const runnableTasks = lines
            .map((line, lineNumber) => ({ lineNumber, task: parseSpecTaskLine(line) }))
            .filter(item => item.task && item.task.status !== 'completed' && !hasChildSpecTasks(lines, item.lineNumber));

        if (runnableTasks.length > 0) {
            codeLenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: `Start All Tasks (${runnableTasks.length})`,
                tooltip: 'Implement all pending and in-progress tasks in one agent session',
                command: 'autocode.spec.implAllTasks',
                arguments: [document.uri]
            }));

            if (runnableTasks.length > 1) {
                codeLenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                    title: `Start Parallel Tasks (${runnableTasks.length})`,
                    tooltip: 'Implement independent tasks in separate agent sessions; falls back to sequential execution when file scopes conflict',
                    command: 'autocode.spec.implAllTasksParallel',
                    arguments: [document.uri]
                }));
            }
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const task = parseSpecTaskLine(line);
            if (!task) {
                continue;
            }

            const range = new vscode.Range(i, 0, i, line.length);

            if (task.status === 'completed') {
                codeLenses.push(new vscode.CodeLens(range, {
                    title: 'View Session',
                    tooltip: 'Open the AI terminal or provider history for this completed task',
                    command: 'autocode.spec.viewTaskSession',
                    arguments: [document.uri, i, task.description]
                }));
                continue;
            }

            if (task.status === 'pending') {
                codeLenses.push(new vscode.CodeLens(range, {
                    title: 'Start Task',
                    tooltip: 'Start this task with the active agent provider',
                    command: 'autocode.spec.implTask',
                    arguments: [document.uri, i, task.description, false]
                }));
                continue;
            }

            codeLenses.push(new vscode.CodeLens(range, {
                title: 'Resume Task',
                tooltip: 'Continue this in-progress task without starting over',
                command: 'autocode.spec.implTask',
                arguments: [document.uri, i, task.description, true]
            }));

            codeLenses.push(new vscode.CodeLens(range, {
                title: 'Mark Done',
                tooltip: 'Mark this task as completed',
                command: 'autocode.spec.markTaskDone',
                arguments: [document.uri, i]
            }));

            codeLenses.push(new vscode.CodeLens(range, {
                title: 'View Session',
                tooltip: 'Open the AI terminal or provider history for this in-progress task',
                command: 'autocode.spec.viewTaskSession',
                arguments: [document.uri, i, task.description]
            }));
        }

        return codeLenses;
    }

    public resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken) {
        return codeLens;
    }
}
