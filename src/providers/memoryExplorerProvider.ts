import * as vscode from 'vscode';
import { MemoryManager, StoredMemoryRecord } from '../features/memory/memoryManager';

type MemoryGroupId = 'project' | 'user' | 'spec' | 'session' | 'pitfall';

interface MemoryGroup {
    id: MemoryGroupId;
    label: string;
    icon: string;
    description: string;
}

const MEMORY_GROUPS: MemoryGroup[] = [
    {
        id: 'project',
        label: 'Project Memory',
        icon: 'repo',
        description: 'Project facts, decisions, commands, and conventions'
    },
    {
        id: 'user',
        label: 'User Preferences',
        icon: 'account',
        description: 'User-wide preferences stored outside the repository'
    },
    {
        id: 'spec',
        label: 'Spec Memory',
        icon: 'book',
        description: 'Spec and task execution history'
    },
    {
        id: 'session',
        label: 'Session History',
        icon: 'history',
        description: 'Recorded AI task sessions'
    },
    {
        id: 'pitfall',
        label: 'Pitfalls',
        icon: 'warning',
        description: 'Known failures, caveats, and recovery notes'
    }
];

export class MemoryExplorerProvider implements vscode.TreeDataProvider<MemoryTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<MemoryTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private memoryManager: MemoryManager) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: MemoryTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: MemoryTreeItem): Promise<MemoryTreeItem[]> {
        if (!this.memoryManager.isEnabled()) {
            return [
                new MemoryTreeItem(
                    'Memory is disabled',
                    vscode.TreeItemCollapsibleState.None,
                    'memory-disabled',
                    undefined,
                    'Enable autocode.memory.enabled to use memory.'
                )
            ];
        }

        if (!element) {
            return MEMORY_GROUPS.map(group => new MemoryTreeItem(
                group.label,
                vscode.TreeItemCollapsibleState.Collapsed,
                `memory-group-${group.id}`,
                undefined,
                group.description,
                new vscode.ThemeIcon(group.icon),
                group
            ));
        }

        if (element.group) {
            const records = await this.memoryManager.listRecords(element.group.id);
            if (records.length === 0) {
                return [
                    new MemoryTreeItem(
                        'No memory yet',
                        vscode.TreeItemCollapsibleState.None,
                        'memory-empty',
                        undefined,
                        'Memory will appear here after specs or tasks create it.'
                    )
                ];
            }

            return records.map(record => new MemoryTreeItem(
                this.formatRecordLabel(record),
                vscode.TreeItemCollapsibleState.None,
                'memory-record',
                record,
                this.formatRecordTooltip(record),
                new vscode.ThemeIcon(this.getRecordIcon(record))
            ));
        }

        return [];
    }

    private formatRecordLabel(record: StoredMemoryRecord): string {
        const compact = record.text.replace(/\s+/g, ' ').trim();
        return compact.length <= 72 ? compact : `${compact.slice(0, 69)}...`;
    }

    private formatRecordTooltip(record: StoredMemoryRecord): string {
        return [
            record.text,
            '',
            `Scope: ${record.scope}`,
            `Type: ${record.type}`,
            `Confidence: ${record.confidence}`,
            `Created: ${record.createdAt}`,
            record.tags?.length ? `Tags: ${record.tags.join(', ')}` : '',
            record.source?.path ? `Source: ${record.source.path}` : ''
        ].filter(Boolean).join('\n');
    }

    private getRecordIcon(record: StoredMemoryRecord): string {
        if (record.type === 'pitfall') {
            return 'warning';
        }
        if (record.type === 'preference') {
            return 'account';
        }
        if (record.type === 'verification') {
            return 'verified';
        }
        if (record.scope === 'session') {
            return 'history';
        }
        return 'note';
    }
}

class MemoryTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly record?: StoredMemoryRecord,
        tooltip?: string,
        iconPath?: vscode.ThemeIcon,
        public readonly group?: MemoryGroup
    ) {
        super(label, collapsibleState);
        this.label = label;
        this.tooltip = tooltip;
        this.iconPath = iconPath;

        if (record) {
            this.description = `${record.scope}/${record.type}`;
            this.command = record.source?.path
                ? {
                    command: 'autocode.memory.openSource',
                    title: 'Open Memory Source',
                    arguments: [record]
                }
                : undefined;
        }
    }
}
