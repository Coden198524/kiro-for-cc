import * as vscode from 'vscode';
import * as path from 'path';
import { AgentManager, AgentInfo, AgentTargetProvider } from '../features/agents/agentManager';
import { AgentProviderConfig } from '../runtime/agentRuntime';
import { getProviderConfig } from '../runtime/providerRegistry';

export class AgentsExplorerProvider implements vscode.TreeDataProvider<AgentItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AgentItem | undefined | null | void> = new vscode.EventEmitter<AgentItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<AgentItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private fileWatchers: vscode.FileSystemWatcher[] = [];
    private isLoading: boolean = false;

    constructor(
        private context: vscode.ExtensionContext,
        private agentManager: AgentManager,
        private outputChannel: vscode.OutputChannel,
        private provider?: AgentProviderConfig
    ) {
        this.setupFileWatchers();
    }

    refresh(): void {
        this.provider = getProviderConfig();
        this.isLoading = true;
        this._onDidChangeTreeData.fire(); // Show loading state immediately
        
        // Simulate async loading
        setTimeout(() => {
            this.isLoading = false;
            this._onDidChangeTreeData.fire(); // Show actual content
        }, 100);
    }

    getTreeItem(element: AgentItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AgentItem): Promise<AgentItem[]> {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        if (!element) {
            // Root level - show loading state or agent groups
            const items: AgentItem[] = [];

            if (this.provider && !this.provider.capabilities.expertAgents) {
                items.push(new AgentItem(
                    `Expert agents are unavailable for ${this.provider.displayName}`,
                    vscode.TreeItemCollapsibleState.None,
                    'agent-provider-unsupported'
                ));
                return items;
            }

            if (this.isLoading) {
                // Show loading state
                items.push(new AgentItem(
                    'Loading agents...',
                    vscode.TreeItemCollapsibleState.None,
                    'agent-loading'
                ));
                return items;
            }

            // User agents group - always show it (first)
            items.push(new AgentItem(
                'User Agents',
                vscode.TreeItemCollapsibleState.Expanded,
                'agent-group',
                'user'
            ));

            // Project agents group
            const projectAgents = await this.agentManager.getAgentList('project', this.getAgentTargetProvider());
            if (projectAgents.length > 0 || vscode.workspace.workspaceFolders) {
                items.push(new AgentItem(
                    'Project Agents',
                    vscode.TreeItemCollapsibleState.Expanded,
                    'agent-group',
                    'project'
                ));
            }

            return items;
        } else if (element.contextValue === 'agent-group') {
            // Show agents under the group
            const agents = await this.agentManager.getAgentList(
                element.groupType as 'project' | 'user',
                this.getAgentTargetProvider()
            );
            return agents.map(agent => new AgentItem(
                agent.name,
                vscode.TreeItemCollapsibleState.None,
                'agent',
                undefined,
                agent
            ));
        }

        return [];
    }

    private setupFileWatchers(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        // Watch project agents directory
        if (workspaceFolder) {
            this.watchPattern(new vscode.RelativePattern(workspaceFolder, '.autocode/agents/**/*.md'));
            this.watchPattern(new vscode.RelativePattern(workspaceFolder, '.codex/agents/**/*.toml'));
        }

        this.watchUserPattern(path.join(require('os').homedir(), '.claude/agents'), '**/*.md');
        this.watchUserPattern(path.join(require('os').homedir(), '.codex/agents'), '**/*.toml');
    }

    dispose(): void {
        for (const watcher of this.fileWatchers) {
            watcher.dispose();
        }
        this.fileWatchers = [];
    }

    private getAgentTargetProvider(): AgentTargetProvider {
        if (this.provider?.id === 'codex') {
            return 'codex';
        }

        if (this.provider?.id === 'claude') {
            return 'claude';
        }

        return 'all';
    }

    private watchUserPattern(rootPath: string, pattern: string): void {
        try {
            this.watchPattern(new vscode.RelativePattern(rootPath, pattern));
        } catch (error) {
            this.outputChannel.appendLine(`[AgentsExplorer] Failed to watch user agents directory: ${error}`);
        }
    }

    private watchPattern(pattern: vscode.RelativePattern): void {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidCreate(() => this._onDidChangeTreeData.fire());
        watcher.onDidChange(() => this._onDidChangeTreeData.fire());
        watcher.onDidDelete(() => this._onDidChangeTreeData.fire());
        this.fileWatchers.push(watcher);
    }
}

class AgentItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly groupType?: string,
        public readonly agentInfo?: AgentInfo
    ) {
        super(label, collapsibleState);

        if (contextValue === 'agent-loading') {
            // Loading state with spinning icon
            this.iconPath = new vscode.ThemeIcon('sync~spin');
            this.tooltip = 'Loading agents...';
        } else if (contextValue === 'agent-provider-unsupported') {
            this.iconPath = new vscode.ThemeIcon('info');
            this.tooltip = 'This provider does not expose specialized agent files.';
        } else if (contextValue === 'agent-group') {
            // Use icons similar to Steering Explorer
            if (groupType === 'user') {
                this.iconPath = new vscode.ThemeIcon('globe');
                this.tooltip = 'User-wide agents available across all projects';
            } else {
                this.iconPath = new vscode.ThemeIcon('root-folder');
                this.tooltip = 'Project-specific agents';
            }
        } else if (contextValue === 'agent' && agentInfo) {
            this.iconPath = new vscode.ThemeIcon('robot');
            this.tooltip = agentInfo.description || agentInfo.name;
            this.description = agentInfo.tools ? `Tools: ${agentInfo.tools.length}` : undefined;

            // Add command to open agent file
            this.command = {
                command: 'vscode.open',
                title: 'Open Agent',
                arguments: [vscode.Uri.file(agentInfo.path)]
            };
        }
    }
}
