import * as vscode from 'vscode';
import * as path from 'path';
import { SpecManager } from '../features/spec/specManager';
import {
    AutoTaskQueueRecoveryRecord,
    AutoTaskQueueTaskState,
    findRecoverableAutoTaskQueues,
    getAutoTaskQueueSummary
} from '../features/spec/taskQueueController';

export class SpecExplorerProvider implements vscode.TreeDataProvider<SpecItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SpecItem | undefined | null | void> = new vscode.EventEmitter<SpecItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SpecItem | undefined | null | void> = this._onDidChangeTreeData.event;
    
    private specManager!: SpecManager;
    private outputChannel: vscode.OutputChannel;
    private isLoading: boolean = false;
    
    constructor(private context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        // We'll set the spec manager later from extension.ts
        this.outputChannel = outputChannel;
    }
    
    setSpecManager(specManager: SpecManager) {
        this.specManager = specManager;
    }
    
    refresh(): void {
        this.isLoading = true;
        this._onDidChangeTreeData.fire(); // Show loading state immediately
        
        // Simulate async loading
        setTimeout(() => {
            this.isLoading = false;
            this._onDidChangeTreeData.fire(); // Show actual content
        }, 100);
    }
    
    getTreeItem(element: SpecItem): vscode.TreeItem {
        return element;
    }
    
    async getChildren(element?: SpecItem): Promise<SpecItem[]> {
        
        if (!vscode.workspace.workspaceFolders || !this.specManager) {
            return [];
        }
        
        if (!element) {
            // Root level - show loading state or specs
            const items: SpecItem[] = [];
            
            if (this.isLoading) {
                // Show loading state
                items.push(new SpecItem(
                    'Loading specs...',
                    vscode.TreeItemCollapsibleState.None,
                    'spec-loading',
                    this.context
                ));
                return items;
            }

            items.push(...await this.getActionItems());
            items.push(...await this.getQueueStatusItems());
            
            // Show all specs
            const specs = await this.specManager.getSpecList();
            const specItems = specs.map(specName => new SpecItem(
                specName,
                vscode.TreeItemCollapsibleState.Expanded,
                'spec',
                this.context,
                specName
            ));
            
            return [...items, ...specItems];
        } else if (element.contextValue === 'spec-task-queue-group') {
            return this.getQueueItems();
        } else if (element.contextValue === 'spec-task-queue' && element.queue) {
            return this.getQueueDetailItems(element.queue);
        } else if (element.contextValue === 'spec') {
            // Show spec documents
            const specsPath = await this.specManager.getSpecBasePath();
            const specPath = `${specsPath}/${element.specName}`;
            
            return [
                new SpecItem(
                    'requirements',
                    vscode.TreeItemCollapsibleState.None,
                    'spec-document',
                    this.context,
                    element.specName!,
                    'requirements',
                    {
                        command: 'autocode.spec.navigate.requirements',
                        title: 'Open Requirements',
                        arguments: [element.specName]
                    },
                    `${specPath}/requirements.md`
                ),
                new SpecItem(
                    'design',
                    vscode.TreeItemCollapsibleState.None,
                    'spec-document',
                    this.context,
                    element.specName!,
                    'design',
                    {
                        command: 'autocode.spec.navigate.design',
                        title: 'Open Design',
                        arguments: [element.specName]
                    },
                    `${specPath}/design.md`
                ),
                new SpecItem(
                    'tasks',
                    vscode.TreeItemCollapsibleState.None,
                    'spec-document',
                    this.context,
                    element.specName!,
                    'tasks',
                    {
                        command: 'autocode.spec.navigate.tasks',
                        title: 'Open Tasks',
                        arguments: [element.specName]
                    },
                    `${specPath}/tasks.md`
                )
            ];
        }
        
        return [];
    }

    private async getActionItems(): Promise<SpecItem[]> {
        return [
            new SpecItem(
                'Initialize Project Context',
                vscode.TreeItemCollapsibleState.None,
                'spec-action-init-context',
                this.context,
                undefined,
                undefined,
                {
                    command: 'autocode.steering.generateInitial',
                    title: 'Initialize Project Context'
                }
            ),
            new SpecItem(
                'Create New Spec',
                vscode.TreeItemCollapsibleState.None,
                'spec-action-create',
                this.context,
                undefined,
                undefined,
                {
                    command: 'autocode.spec.create',
                    title: 'Create New Spec'
                }
            ),
            new SpecItem(
                'Create Spec with Agents',
                vscode.TreeItemCollapsibleState.None,
                'spec-action-create-agents',
                this.context,
                undefined,
                undefined,
                {
                    command: 'autocode.spec.createWithAgents',
                    title: 'Create Spec with Agents'
                }
            )
        ];
    }

    private async getQueueStatusItems(): Promise<SpecItem[]> {
        const queues = await this.getRecoverableQueues();
        if (queues.length === 0) {
            return [];
        }

        return [
            new SpecItem(
                `Auto Task Queues (${queues.length})`,
                vscode.TreeItemCollapsibleState.Expanded,
                'spec-task-queue-group',
                this.context,
                undefined,
                undefined,
                {
                    command: 'autocode.spec.showTaskQueues',
                    title: 'Review Auto Task Queues'
                }
            )
        ];
    }

    private async getQueueItems(): Promise<SpecItem[]> {
        const queues = await this.getRecoverableQueues();
        return queues.map(queue => {
            const summary = getAutoTaskQueueSummary(queue.record);
            const queuedTasks = getQueuedTasks(queue.record);
            const failedCount = queue.record.status === 'paused' ? queuedTasks.length : 0;
            const detail = [
                `${formatQueueStatus(queue.record.status)}`,
                `${summary.taskCount} task(s)`,
                failedCount > 0 ? `${failedCount} pending/failed` : undefined
            ].filter(Boolean).join(' - ');

            return new SpecItem(
                queue.specName,
                vscode.TreeItemCollapsibleState.Expanded,
                'spec-task-queue',
                this.context,
                queue.specName,
                undefined,
                {
                    command: 'autocode.spec.showTaskQueueDetails',
                    title: 'Show Auto Task Queue Details',
                    arguments: [queue.documentUri]
                },
                undefined,
                queue,
                detail
            );
        });
    }

    private getQueueDetailItems(queue: AutoTaskQueueRecoveryRecord): SpecItem[] {
        const record = queue.record;
        const queuedTasks = getQueuedTasks(record);
        const details = [
            this.createQueueDetailItem(`Status: ${formatQueueStatus(record.status)}`, record.pauseReason ? 'paused' : undefined),
            this.createQueueDetailItem(`Command: ${record.commandId}`),
            this.createQueueDetailItem(`Queued tasks: ${queuedTasks.length}`),
            record.batchTasks?.length ? this.createQueueDetailItem(`Current batch: ${record.batchTasks.length} task(s)`) : undefined,
            record.pauseReason ? this.createQueueDetailItem(`Pause reason: ${record.pauseReason}`) : undefined,
            record.lastEvent ? this.createQueueDetailItem(`Last event: ${record.lastEvent}`) : undefined
        ].filter((item): item is SpecItem => Boolean(item));

        const taskDetails = queuedTasks.map(task => this.createQueueTaskItem(record.status, task));
        return [...details, ...taskDetails];
    }

    private createQueueDetailItem(label: string, description?: string): SpecItem {
        return new SpecItem(
            label,
            vscode.TreeItemCollapsibleState.None,
            'spec-task-queue-detail',
            this.context,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            description
        );
    }

    private createQueueTaskItem(status: string, task: AutoTaskQueueTaskState): SpecItem {
        const prefix = status === 'paused'
            ? 'Pending/failed'
            : status === 'waiting_for_signal'
                ? 'Waiting'
                : 'Task';
        return this.createQueueDetailItem(`${prefix} ${task.lineNumber + 1}: ${task.taskDescription}`);
    }

    private async getRecoverableQueues(): Promise<AutoTaskQueueRecoveryRecord[]> {
        try {
            const specBasePath = await this.specManager.getSpecBasePath();
            return await findRecoverableAutoTaskQueues(vscode.workspace.workspaceFolders, specBasePath);
        } catch (error) {
            this.outputChannel.appendLine(`[SpecExplorer] Failed to inspect auto task queues: ${error}`);
            return [];
        }
    }
}

class SpecItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        private readonly context: vscode.ExtensionContext,
        public readonly specName?: string,
        public readonly documentType?: string,
        public readonly command?: vscode.Command,
        private readonly filePath?: string,
        public readonly queue?: AutoTaskQueueRecoveryRecord,
        private readonly detailDescription?: string
    ) {
        super(label, collapsibleState);
        
        if (contextValue === 'spec-loading') {
            this.iconPath = new vscode.ThemeIcon('sync~spin');
            this.tooltip = 'Loading specs...';
        } else if (contextValue.startsWith('spec-action-')) {
            this.tooltip = command?.title ?? label;

            if (contextValue === 'spec-action-init-context') {
                this.iconPath = new vscode.ThemeIcon('repo');
            } else if (contextValue === 'spec-action-create-agents') {
                this.iconPath = new vscode.ThemeIcon('sparkle');
            } else {
                this.iconPath = new vscode.ThemeIcon('plus');
            }
        } else if (contextValue === 'spec-task-queue-group') {
            this.iconPath = new vscode.ThemeIcon('list-tree');
            this.description = 'active';
            this.tooltip = 'Active AutoCode task queues';
        } else if (contextValue === 'spec-task-queue') {
            this.iconPath = getQueueStatusIcon(queue?.record.status);
            this.description = detailDescription;
            this.tooltip = queue ? formatQueueTooltip(queue) : label;
        } else if (contextValue === 'spec-task-queue-detail') {
            this.iconPath = new vscode.ThemeIcon('debug-stackframe-dot');
            this.description = detailDescription;
            this.tooltip = label;
        } else if (contextValue === 'spec') {
            this.iconPath = new vscode.ThemeIcon('package');
            this.tooltip = `Spec: ${label}`;
        } else if (contextValue === 'spec-document') {
            // Different icons for different document types
            if (documentType === 'requirements') {
                this.iconPath = new vscode.ThemeIcon('chip');
                this.tooltip = `Requirements: ${specName}/${label}`;
            } else if (documentType === 'design') {
                this.iconPath = new vscode.ThemeIcon('layers');
                this.tooltip = `Design: ${specName}/${label}`;
            } else if (documentType === 'tasks') {
                this.iconPath = new vscode.ThemeIcon('tasklist');
                this.tooltip = `Tasks: ${specName}/${label}`;
            } else {
                this.iconPath = new vscode.ThemeIcon('file');
                this.tooltip = `${documentType}: ${specName}/${label}`;
            }
            
            // Set description to file path
            if (filePath) {
                this.description = filePath;
            }
            
            // Add context menu items
            if (documentType === 'requirements' || documentType === 'design' || documentType === 'tasks') {
                this.contextValue = `spec-document-${documentType}`;
            }
        }
    }
}

function getQueuedTasks(record: AutoTaskQueueRecoveryRecord['record']): AutoTaskQueueTaskState[] {
    return [
        ...(record.currentTask ? [record.currentTask] : []),
        ...(record.batchTasks ?? [])
    ];
}

function formatQueueStatus(status: string): string {
    return status.replace(/_/g, ' ');
}

function getQueueStatusIcon(status: string | undefined): vscode.ThemeIcon {
    if (status === 'paused') {
        return new vscode.ThemeIcon('debug-pause');
    }

    if (status === 'waiting_for_signal') {
        return new vscode.ThemeIcon('watch');
    }

    if (status === 'running') {
        return new vscode.ThemeIcon('debug-start');
    }

    return new vscode.ThemeIcon('list-tree');
}

function formatQueueTooltip(queue: AutoTaskQueueRecoveryRecord): string {
    const record = queue.record;
    const queuedTasks = getQueuedTasks(record);
    return [
        `Spec: ${queue.specName}`,
        `Status: ${formatQueueStatus(record.status)}`,
        `Queued tasks: ${queuedTasks.length}`,
        record.batchTasks?.length ? `Current batch: ${record.batchTasks.length}` : undefined,
        record.pauseReason ? `Pause reason: ${record.pauseReason}` : undefined,
        record.lastEvent ? `Last event: ${record.lastEvent}` : undefined
    ].filter(Boolean).join('\n');
}
