import * as vscode from 'vscode';
import { MemoryManager, MemoryType, StoredMemoryRecord } from '../features/memory/memoryManager';
import { MemoryExplorerProvider } from '../providers/memoryExplorerProvider';

export interface RegisterMemoryCommandsOptions {
    context: vscode.ExtensionContext;
    memoryManager: MemoryManager;
    memoryExplorer: MemoryExplorerProvider;
    outputChannel: vscode.OutputChannel;
}

export function registerMemoryCommands(options: RegisterMemoryCommandsOptions): void {
    const {
        context,
        memoryManager,
        memoryExplorer,
        outputChannel
    } = options;

    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.memory.refresh', async () => {
            outputChannel.appendLine('[Memory] Refreshing memory explorer...');
            memoryExplorer.refresh();
        }),
        vscode.commands.registerCommand('autocode.memory.createProjectMemory', async () => {
            const text = await vscode.window.showInputBox({
                title: 'Add Project Memory',
                prompt: 'Record a project fact, convention, command, decision, or pitfall.',
                placeHolder: 'Example: StartAllTasks must launch the next task only after verification passes.',
                ignoreFocusOut: true
            });
            if (!text) {
                return;
            }

            const type = await vscode.window.showQuickPick(
                ['fact', 'decision', 'pitfall', 'command'] as const,
                {
                    title: 'Memory Type',
                    placeHolder: 'Choose how this project memory should be classified'
                }
            );
            if (!type) {
                return;
            }

            await memoryManager.addMemory({
                scope: 'project',
                type: type as MemoryType,
                text,
                source: { kind: 'user' },
                confidence: 1
            });
            memoryExplorer.refresh();
        }),
        vscode.commands.registerCommand('autocode.memory.createUserPreference', async () => {
            const text = await vscode.window.showInputBox({
                title: 'Add User Preference',
                prompt: 'Record a user-wide preference that should apply across projects.',
                placeHolder: 'Example: Prefer Chinese for task summaries and user-facing explanations.',
                ignoreFocusOut: true
            });
            if (!text) {
                return;
            }

            await memoryManager.addMemory({
                scope: 'user',
                type: 'preference',
                text,
                source: { kind: 'user' },
                tags: ['preference'],
                confidence: 1
            });
            memoryExplorer.refresh();
        }),
        vscode.commands.registerCommand('autocode.memory.openProjectMemory', async () => {
            await memoryManager.openProjectMemoryFile();
        }),
        vscode.commands.registerCommand('autocode.memory.openSource', async (record?: StoredMemoryRecord) => {
            if (!record) {
                vscode.window.showWarningMessage('No memory item selected.');
                return;
            }

            await memoryManager.openMemorySource(record);
        }),
        vscode.commands.registerCommand('autocode.memory.accept', async (record?: StoredMemoryRecord) => {
            if (!record) {
                vscode.window.showWarningMessage('No memory item selected.');
                return;
            }

            const accepted = await memoryManager.acceptMemory(record);
            if (accepted) {
                vscode.window.showInformationMessage('Memory accepted.');
                memoryExplorer.refresh();
            }
        }),
        vscode.commands.registerCommand('autocode.memory.forget', async (record?: StoredMemoryRecord) => {
            if (!record) {
                vscode.window.showWarningMessage('No memory item selected.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                'Forget this memory? It will be hidden from future retrieval but kept in the JSONL audit trail.',
                'Forget',
                'Cancel'
            );
            if (confirm !== 'Forget') {
                return;
            }

            const forgotten = await memoryManager.forgetMemory(record);
            if (forgotten) {
                vscode.window.showInformationMessage('Memory forgotten.');
                memoryExplorer.refresh();
            }
        })
    );
}
