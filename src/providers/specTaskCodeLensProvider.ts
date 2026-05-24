import * as vscode from 'vscode';
import { parseSpecTaskLine } from '../features/spec/taskStatus';
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

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const specDir = this.configManager.getPath('specs');
        const normalizedSpecDir = specDir.replace(/\\/g, '/');
        const normalizedFileName = document.fileName.replace(/\\/g, '/');

        const specDirSegment = `/${normalizedSpecDir}/`;
        if (!normalizedFileName.includes(specDirSegment) || !normalizedFileName.endsWith('tasks.md')) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];
        const lines = document.getText().split(/\r?\n/);

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
                    tooltip: 'Open the saved AI session for this completed task',
                    command: 'kfc.spec.viewTaskSession',
                    arguments: [document.uri, i, task.description]
                }));
                continue;
            }

            if (task.status === 'pending') {
                codeLenses.push(new vscode.CodeLens(range, {
                    title: 'Start Task',
                    tooltip: 'Start this task with the active agent provider',
                    command: 'kfc.spec.implTask',
                    arguments: [document.uri, i, task.description, false]
                }));
                continue;
            }

            codeLenses.push(new vscode.CodeLens(range, {
                title: 'Resume Task',
                tooltip: 'Continue this in-progress task without starting over',
                command: 'kfc.spec.implTask',
                arguments: [document.uri, i, task.description, true]
            }));

            codeLenses.push(new vscode.CodeLens(range, {
                title: 'Mark Done',
                tooltip: 'Mark this task as completed',
                command: 'kfc.spec.markTaskDone',
                arguments: [document.uri, i]
            }));

            codeLenses.push(new vscode.CodeLens(range, {
                title: 'View Session',
                tooltip: 'Open the saved AI session for this in-progress task',
                command: 'kfc.spec.viewTaskSession',
                arguments: [document.uri, i, task.description]
            }));
        }

        return codeLenses;
    }

    public resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken) {
        return codeLens;
    }
}
