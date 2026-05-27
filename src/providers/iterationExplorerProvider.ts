import * as vscode from 'vscode';
import { IterationManager, IterationMode, IterationRecord } from '../features/iteration/iterationManager';
import { localize } from '../utils/localization';

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
            this.createActionItem(localize('Start Iteration', '启动迭代'), 'autocode.iteration.start', 'sparkle'),
            this.createActionItem(localize('Ask / Analyze', '询问 / 分析'), 'autocode.iteration.ask', 'comment-discussion'),
            this.createActionItem(localize('Edit / Fix', '编辑 / 修复'), 'autocode.iteration.edit', 'tools'),
            this.createActionItem(localize('Generate Document', '生成文档'), 'autocode.iteration.document', 'book')
        ];
        const records = await this.iterationManager.listRecent(8);
        const recordItems = records.map(record => this.createRecordItem(record));

        if (recordItems.length === 0) {
            return [
                ...actionItems,
                new IterationTreeItem(localize('No recent iterations', '没有最近的迭代'), vscode.TreeItemCollapsibleState.None, 'action')
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
            title: localize('Open Iteration Summary', '打开迭代摘要'),
            arguments: [record]
        };
        return item;
    }

    private formatMode(mode: IterationMode): string {
        switch (mode) {
            case 'ask':
                return localize('Ask', '询问');
            case 'edit':
                return localize('Edit', '编辑');
            case 'document':
                return localize('Document', '文档');
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
