import * as vscode from 'vscode';
import { MemoryManager, StoredMemoryRecord } from '../features/memory/memoryManager';

type MemoryGroupId = 'pending' | 'project' | 'user' | 'spec' | 'session' | 'pitfall';
export type MemoryFilterCategory = 'all' | MemoryGroupId | 'conflict';

export interface MemoryExplorerFilter {
    query?: string;
    category?: MemoryFilterCategory;
}

interface MemoryGroup {
    id: MemoryGroupId;
    label: string;
    icon: string;
    description: string;
}

const MEMORY_GROUPS: MemoryGroup[] = [
    {
        id: 'pending',
        label: 'Review Inbox',
        icon: 'inbox',
        description: 'Pending memories waiting for review'
    },
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

const FILTER_CATEGORY_LABELS: Record<MemoryFilterCategory, string> = {
    all: 'All Memory',
    pending: 'Review Inbox',
    project: 'Project Memory',
    user: 'User Preferences',
    spec: 'Spec Memory',
    session: 'Session History',
    pitfall: 'Pitfalls',
    conflict: 'Conflicts'
};

export class MemoryExplorerProvider implements vscode.TreeDataProvider<MemoryTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<MemoryTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private filter: MemoryExplorerFilter = {};

    constructor(private memoryManager: MemoryManager) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setFilter(filter: MemoryExplorerFilter): void {
        this.filter = {
            query: filter.query?.trim() || undefined,
            category: filter.category && filter.category !== 'all' ? filter.category : undefined
        };
        this.refresh();
    }

    clearFilter(): void {
        this.filter = {};
        this.refresh();
    }

    getFilter(): MemoryExplorerFilter {
        return { ...this.filter };
    }

    hasActiveFilter(): boolean {
        return Boolean(this.filter.query || this.filter.category);
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
            if (this.hasActiveFilter()) {
                return [
                    new MemoryTreeItem(
                        'Filtered Memory',
                        vscode.TreeItemCollapsibleState.Expanded,
                        'memory-filter-group',
                        undefined,
                        this.formatFilterDescription(),
                        new vscode.ThemeIcon('filter'),
                        undefined,
                        true
                    )
                ];
            }

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

        if (element.filterRoot) {
            const records = await this.listFilteredRecords();
            if (records.length === 0) {
                return [
                    new MemoryTreeItem(
                        'No matching memory',
                        vscode.TreeItemCollapsibleState.None,
                        'memory-empty',
                        undefined,
                        'Adjust or clear the current memory filter.'
                    )
                ];
            }

            return records.map(record => this.createRecordItem(record));
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

            return records.map(record => this.createRecordItem(record));
        }

        return [];
    }

    private async listFilteredRecords(): Promise<StoredMemoryRecord[]> {
        const category = this.filter.category;
        const records = await this.memoryManager.listRecords(category);
        const query = this.filter.query;
        if (!query) {
            return records;
        }

        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
            return records;
        }

        return records.filter(record => this.matchesQuery(record, tokens));
    }

    private matchesQuery(record: StoredMemoryRecord, tokens: readonly string[]): boolean {
        const haystack = [
            record.text,
            record.scope,
            record.type,
            record.status ?? 'active',
            record.subject ?? '',
            record.source?.path ?? '',
            ...(record.tags ?? []),
            record.metadata ? JSON.stringify(record.metadata) : ''
        ].join(' ').toLowerCase();

        return tokens.every(token => haystack.includes(token));
    }

    private createRecordItem(record: StoredMemoryRecord): MemoryTreeItem {
        return new MemoryTreeItem(
            this.formatRecordLabel(record),
            vscode.TreeItemCollapsibleState.None,
            'memory-record',
            record,
            this.formatRecordTooltip(record),
            new vscode.ThemeIcon(this.getRecordIcon(record))
        );
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
            `Status: ${record.status ?? 'active'}`,
            `Confidence: ${record.confidence}`,
            `Created: ${record.createdAt}`,
            record.tags?.length ? `Tags: ${record.tags.join(', ')}` : '',
            record.source?.path ? `Source: ${record.source.path}` : ''
        ].filter(Boolean).join('\n');
    }

    private formatFilterDescription(): string {
        const parts = [
            this.filter.category ? FILTER_CATEGORY_LABELS[this.filter.category] : undefined,
            this.filter.query ? `Query: ${this.filter.query}` : undefined
        ].filter(Boolean);

        return parts.length > 0 ? parts.join(' | ') : 'No filter';
    }

    private getRecordIcon(record: StoredMemoryRecord): string {
        if (record.status === 'conflict') {
            return 'warning';
        }
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
        public readonly group?: MemoryGroup,
        public readonly filterRoot = false
    ) {
        super(label, collapsibleState);
        this.label = label;
        this.tooltip = tooltip;
        this.iconPath = iconPath;

        if (filterRoot && tooltip) {
            this.description = tooltip;
        }

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
