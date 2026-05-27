import * as vscode from 'vscode';
import { IterationManager, IterationMode, IterationRecord } from '../features/iteration/iterationManager';

type IterationTreeItemKind = 'action' | 'record';

export class IterationExplorerProvider implements vscode.TreeDataProvider<IterationTreeItem> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<IterationTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor(private iterationManager: IterationManager) { }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(element: IterationTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: IterationTreeItem): Promise<IterationTreeItem[]> {
        if (element) {
            return [];
        }

        const actionItems = [
            this.createActionItem('Start Iteration', 'autocode.iteration.start', 'sparkle'),
            this.createActionItem('Ask / Analyze', 'autocode.iteration.ask', 'comment-discussion'),
            this.createActionItem('Edit / Fix', 'autocode.iteration.edit', 'tools'),
            this.createActionItem('Generate Document', 'autocode.iteration.document', 'book')
        ];
        const records = await this.iterationManager.listRecent(8);
        const recordItems = records.map(record => this.createRecordItem(record));

        if (recordItems.length === 0) {
            return [
                ...actionItems,
                new IterationTreeItem('No recent iterations', vscode.TreeItemCollapsibleState.None, 'action')
            ];
        }

        return [
            ...actionItems,
            ...recordItems
        ];
    }

    private createActionItem(label: string, command: string, icon: string): IterationTreeItem {
        const item = new IterationTreeItem(label, vscode.TreeItemCollapsibleState.None, 'action');
        item.iconPath = new vscode.ThemeIcon(icon);
        item.command = {
            command,
            title: label
        };
        return item;
    }

    private createRecordItem(record: IterationRecord): IterationTreeItem {
        const item = new IterationTreeItem(record.title, vscode.TreeItemCollapsibleState.None, 'record', record);
        item.description = this.formatMode(record.mode);
        item.tooltip = [
            record.title,
            `Mode: ${this.formatMode(record.mode)}`,
            `Started: ${record.startedAt}`,
            record.activeFilePath ? `Active file: ${record.activeFilePath}` : undefined
        ].filter(Boolean).join('\n');
        item.iconPath = new vscode.ThemeIcon(this.getModeIcon(record.mode));
        item.command = {
            command: 'autocode.iteration.openSummary',
            title: 'Open Iteration Summary',
            arguments: [record]
        };
        return item;
    }

    private formatMode(mode: IterationMode): string {
        switch (mode) {
            case 'ask':
                return 'Ask';
            case 'edit':
                return 'Edit';
            case 'document':
                return 'Document';
        }
    }

    private getModeIcon(mode: IterationMode): string {
        switch (mode) {
            case 'ask':
                return 'comment-discussion';
            case 'edit':
                return 'tools';
            case 'document':
                return 'book';
        }
    }
}

export class IterationTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly kind: IterationTreeItemKind,
        public readonly record?: IterationRecord
    ) {
        super(label, collapsibleState);
        this.label = label;
        this.contextValue = kind === 'record' ? 'iteration-record' : 'iteration-action';
    }
}
