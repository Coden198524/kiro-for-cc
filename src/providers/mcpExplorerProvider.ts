import * as vscode from 'vscode';
import { AgentProviderConfig } from '../runtime/agentRuntime';
import { getProviderConfig } from '../runtime/providerRegistry';
import { McpServerInfo } from '../runtime/mcpRegistry';
import { McpStatusService } from '../runtime/mcpStatusService';

export class MCPExplorerProvider implements vscode.TreeDataProvider<MCPItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<MCPItem | undefined | null | void> = new vscode.EventEmitter<MCPItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<MCPItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private servers: McpServerInfo[] = [];
    private isLoading = true;
    private provider: AgentProviderConfig;

    constructor(
        private context: vscode.ExtensionContext,
        private outputChannel: vscode.OutputChannel,
        provider: AgentProviderConfig = getProviderConfig()
    ) {
        this.provider = provider;
        this.loadMCPServers();
    }

    refresh(): void {
        this.provider = getProviderConfig();
        this.isLoading = true;
        this._onDidChangeTreeData.fire();
        this.loadMCPServers();
    }

    getTreeItem(element: MCPItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: MCPItem): Promise<MCPItem[]> {
        if (!element) {
            if (this.isLoading) {
                return [
                    new MCPItem(
                        'Loading MCP servers...',
                        vscode.TreeItemCollapsibleState.None,
                        'mcp-loading',
                        'loading',
                        undefined,
                        this.context
                    )
                ];
            }

            if (this.servers.length === 0) {
                return [
                    new MCPItem(
                        'No MCP servers configured',
                        vscode.TreeItemCollapsibleState.None,
                        'mcp-empty',
                        'empty',
                        undefined,
                        this.context
                    )
                ];
            }

            return this.servers.map((server, index) => new MCPItem(
                server.name,
                vscode.TreeItemCollapsibleState.Collapsed,
                'mcp-server',
                `mcp-${server.providerSource || 'runtime'}-${server.name}-${index}`,
                server,
                this.context
            ));
        }

        if (element.contextValue !== 'mcp-server' || !element.serverInfo) {
            return [];
        }

        return this.getServerDetailItems(element);
    }

    private async loadMCPServers(): Promise<void> {
        try {
            const service = new McpStatusService(this.outputChannel, this.provider);
            this.servers = await service.listServers();
        } catch (error) {
            this.outputChannel.appendLine(`Failed to load MCP servers: ${error}`);
            this.servers = [];
        } finally {
            this.isLoading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    private getServerDetailItems(element: MCPItem): MCPItem[] {
        const server = element.serverInfo!;
        const items: MCPItem[] = [];

        items.push(this.createDetail(element, `Source: ${server.providerSource || 'Runtime'}`, 'source'));
        items.push(this.createDetail(element, `Scope: ${server.scope}`, 'scope'));
        items.push(this.createDetail(element, `Type: ${server.type}`, 'type'));
        items.push(this.createDetail(element, `Status: ${server.status}`, 'status'));

        if (server.description) {
            items.push(this.createDetail(element, `Description: ${server.description}`, 'description'));
        }

        if (server.type === 'stdio') {
            const command = [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
            if (command) {
                items.push(this.createDetail(element, `Command: ${command}`, 'command'));
            }
        } else if (server.url) {
            items.push(this.createDetail(element, `URL: ${server.url}`, 'url'));
        }

        if (server.headers && Object.keys(server.headers).length > 0) {
            items.push(this.createDetail(element, `Headers: ${Object.keys(server.headers).join(', ')}`, 'headers'));
        }

        if (server.env && Object.keys(server.env).length > 0) {
            const envStr = Object.entries(server.env)
                .map(([key, value]) => `${key}=${value}`)
                .join(', ');
            items.push(this.createDetail(element, `Environment: ${envStr}`, 'env'));
        }

        if (server.removeCommand) {
            items.push(this.createDetail(element, `Remove: ${server.removeCommand}`, 'remove'));
        }

        return items;
    }

    private createDetail(parent: MCPItem, label: string, suffix: string): MCPItem {
        return new MCPItem(
            label,
            vscode.TreeItemCollapsibleState.None,
            'mcp-detail',
            `${parent.id}-${suffix}`,
            undefined,
            this.context
        );
    }
}

class MCPItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly id: string,
        public readonly serverInfo?: McpServerInfo,
        private readonly context?: vscode.ExtensionContext
    ) {
        super(label, collapsibleState);

        if (contextValue === 'mcp-empty') {
            this.iconPath = new vscode.ThemeIcon('info');
        } else if (contextValue === 'mcp-loading') {
            this.iconPath = new vscode.ThemeIcon('sync~spin');
        } else if (contextValue === 'mcp-server') {
            if (serverInfo?.status === 'disconnected' || serverInfo?.status === 'unsupported') {
                this.iconPath = new vscode.ThemeIcon('debug-disconnect');
            } else {
                this.iconPath = new vscode.ThemeIcon('server-environment');
            }
        } else if (contextValue === 'mcp-detail') {
            this.iconPath = this.getDetailIcon(label);
        } else if (context) {
            this.iconPath = {
                light: vscode.Uri.file(context.asAbsolutePath('icons/server.svg')),
                dark: vscode.Uri.file(context.asAbsolutePath('icons/server.svg'))
            };
        } else {
            this.iconPath = new vscode.ThemeIcon('server-environment');
        }

        if (contextValue === 'mcp-server' && serverInfo) {
            this.description = serverInfo.providerSource;
            this.tooltip = [
                `MCP Server: ${label}`,
                `Source: ${serverInfo.providerSource || 'Runtime'}`,
                `Type: ${serverInfo.type}`,
                `Scope: ${serverInfo.scope}`,
                `Status: ${serverInfo.status}`
            ].join('\n');
        } else if (contextValue === 'mcp-detail') {
            this.tooltip = label;
        }
    }

    private getDetailIcon(label: string): vscode.ThemeIcon {
        if (label.startsWith('Type:') || label.startsWith('Status:') || label.startsWith('Source:')) {
            return new vscode.ThemeIcon('symbol-property');
        }
        if (label.startsWith('Command:') || label.startsWith('Remove:')) {
            return new vscode.ThemeIcon('terminal');
        }
        if (label.startsWith('URL:')) {
            return new vscode.ThemeIcon('link');
        }
        if (label.startsWith('Environment:')) {
            return new vscode.ThemeIcon('symbol-variable');
        }
        if (label.startsWith('Scope:')) {
            return new vscode.ThemeIcon('globe');
        }
        if (label.startsWith('Headers:')) {
            return new vscode.ThemeIcon('symbol-key');
        }
        return new vscode.ThemeIcon('circle-outline');
    }
}
