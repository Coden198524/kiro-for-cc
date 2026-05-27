import * as vscode from 'vscode';
import { MemoryManager, MemoryType, StoredMemoryRecord } from '../features/memory/memoryManager';
import { MemoryExplorerProvider, MemoryFilterCategory } from '../providers/memoryExplorerProvider';

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
        vscode.commands.registerCommand('autocode.memory.search', async () => {
            const currentFilter = memoryExplorer.getFilter();
            const query = await vscode.window.showInputBox({
                title: 'Search Memory',
                prompt: 'Filter the Memory view by text, tag, source path, or metadata.',
                value: currentFilter.query,
                placeHolder: 'Example: task queue verification',
                ignoreFocusOut: true
            });
            if (query === undefined) {
                return;
            }

            memoryExplorer.setFilter({
                ...currentFilter,
                query
            });
        }),
        vscode.commands.registerCommand('autocode.memory.filter', async () => {
            const currentFilter = memoryExplorer.getFilter();
            const items: Array<{
                label: string;
                description: string;
                category?: MemoryFilterCategory;
            }> = [
                { label: 'All Memory', description: 'Show every active memory category' },
                { label: 'Review Inbox', description: 'Pending memories waiting for review', category: 'pending' },
                { label: 'Conflicts', description: 'Memories that conflict with another record', category: 'conflict' },
                { label: 'Project Memory', description: 'Project facts, decisions, commands, and conventions', category: 'project' },
                { label: 'User Preferences', description: 'User-wide preferences', category: 'user' },
                { label: 'Spec Memory', description: 'Spec summaries and task execution history', category: 'spec' },
                { label: 'Session History', description: 'Recorded AI task sessions', category: 'session' },
                { label: 'Pitfalls', description: 'Known failures, caveats, and recovery notes', category: 'pitfall' }
            ];
            const selected = await vscode.window.showQuickPick(items, {
                title: 'Filter Memory',
                placeHolder: 'Choose which memory category to show'
            });
            if (!selected) {
                return;
            }

            memoryExplorer.setFilter({
                ...currentFilter,
                category: selected.category
            });
        }),
        vscode.commands.registerCommand('autocode.memory.clearFilter', async () => {
            memoryExplorer.clearFilter();
            vscode.window.showInformationMessage('Memory filter cleared.');
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
        vscode.commands.registerCommand('autocode.memory.edit', async (record?: StoredMemoryRecord) => {
            if (!record) {
                vscode.window.showWarningMessage('No memory item selected.');
                return;
            }

            const text = await vscode.window.showInputBox({
                title: 'Edit Memory',
                prompt: 'Update this memory text.',
                value: record.text,
                ignoreFocusOut: true
            });
            if (text === undefined) {
                return;
            }

            const updated = await memoryManager.updateMemory(record, { text });
            if (updated) {
                vscode.window.showInformationMessage('Memory updated.');
                memoryExplorer.refresh();
            }
        }),
        vscode.commands.registerCommand('autocode.memory.supersede', async (record?: StoredMemoryRecord) => {
            if (!record) {
                vscode.window.showWarningMessage('No memory item selected.');
                return;
            }

            const text = await vscode.window.showInputBox({
                title: 'Supersede Memory',
                prompt: 'Write the replacement memory. The selected memory will remain in the audit trail as superseded.',
                value: record.text,
                ignoreFocusOut: true
            });
            if (!text) {
                return;
            }

            const replacement = await memoryManager.supersedeMemory(record, text);
            if (replacement) {
                vscode.window.showInformationMessage('Memory superseded.');
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
