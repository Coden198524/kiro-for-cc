import * as vscode from 'vscode';
import * as path from 'path';
import { SpecManager } from '../features/spec/specManager';
import { findRecoverableAutoTaskQueues } from '../features/spec/taskQueueController';

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
        const items = [
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

        const recoverableQueueCount = await this.getRecoverableQueueCount();
        if (recoverableQueueCount > 0) {
            items.push(new SpecItem(
                `Interrupted Auto Queues (${recoverableQueueCount})`,
                vscode.TreeItemCollapsibleState.None,
                'spec-action-task-queues',
                this.context,
                undefined,
                undefined,
                {
                    command: 'autocode.spec.showTaskQueues',
                    title: 'Review Auto Task Queues'
                }
            ));
        }

        return items;
    }

    private async getRecoverableQueueCount(): Promise<number> {
        try {
            const specBasePath = await this.specManager.getSpecBasePath();
            const queues = await findRecoverableAutoTaskQueues(vscode.workspace.workspaceFolders, specBasePath);
            return queues.length;
        } catch (error) {
            this.outputChannel.appendLine(`[SpecExplorer] Failed to inspect auto task queues: ${error}`);
            return 0;
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
        private readonly filePath?: string
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
            } else if (contextValue === 'spec-action-task-queues') {
                this.iconPath = new vscode.ThemeIcon('debug-continue');
                this.description = 'recover';
            } else {
                this.iconPath = new vscode.ThemeIcon('plus');
            }
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
