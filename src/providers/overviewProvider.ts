import * as vscode from 'vscode';
import { VSC_CONFIG_NAMESPACE } from '../constants';
import { getProviderConfig, getProviderDisplayName, listProviderIds } from '../runtime/providerRegistry';
import { ConfigManager } from '../utils/configManager';

export class OverviewProvider implements vscode.TreeDataProvider<OverviewItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<OverviewItem | undefined | null | void> = new vscode.EventEmitter<OverviewItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<OverviewItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {
        this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(VSC_CONFIG_NAMESPACE)) {
                this.refresh();
            }
        }));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: OverviewItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: OverviewItem): Promise<OverviewItem[]> {
        await ConfigManager.getInstance().loadSettings();

        if (!element) {
            return [
                this.createActiveProviderItem(),
                this.createActiveModelItem(),
                this.createProvidersGroup(),
                this.createOpenSettingsItem()
            ];
        }

        if (element.kind === 'providers') {
            const activeProvider = getProviderConfig().id;
            return listProviderIds().map(providerId => {
                const providerName = getProviderDisplayName(providerId);
                const item = new OverviewItem(providerName, vscode.TreeItemCollapsibleState.None, 'provider');
                item.description = providerId === activeProvider ? 'Active' : providerId;
                item.tooltip = providerId === activeProvider
                    ? `${providerName} is active`
                    : `Switch to ${providerName}`;
                item.iconPath = new vscode.ThemeIcon(providerId === activeProvider ? 'check' : 'circle-outline');
                item.command = {
                    command: 'autocode.model.useProvider',
                    title: `Use ${providerName}`,
                    arguments: [providerId]
                };
                return item;
            });
        }

        return [];
    }

    private createActiveProviderItem(): OverviewItem {
        const provider = getProviderConfig();
        const item = new OverviewItem(`Provider: ${provider.displayName}`, vscode.TreeItemCollapsibleState.None, 'action');
        item.description = provider.id;
        item.tooltip = 'Switch active agent provider';
        item.iconPath = new vscode.ThemeIcon('server-environment');
        item.command = {
            command: 'autocode.model.selectProvider',
            title: 'Switch Model Provider'
        };
        return item;
    }

    private createActiveModelItem(): OverviewItem {
        const provider = getProviderConfig();
        const model = provider.model || 'Default';
        const item = new OverviewItem(`Model: ${model}`, vscode.TreeItemCollapsibleState.None, 'action');
        item.description = provider.model ? 'Configured' : 'Provider default';
        item.tooltip = 'Set active model ID';
        item.iconPath = new vscode.ThemeIcon('symbol-key');
        item.command = {
            command: 'autocode.model.setModel',
            title: 'Set Model'
        };
        return item;
    }

    private createProvidersGroup(): OverviewItem {
        const item = new OverviewItem('Providers', vscode.TreeItemCollapsibleState.Expanded, 'providers');
        item.iconPath = new vscode.ThemeIcon('list-tree');
        return item;
    }

    private createOpenSettingsItem(): OverviewItem {
        const item = new OverviewItem('Open Settings', vscode.TreeItemCollapsibleState.None, 'action');
        item.tooltip = 'Open AutoCode settings file';
        item.iconPath = new vscode.ThemeIcon('gear');
        item.command = {
            command: 'autocode.settings.open',
            title: 'Open Settings'
        };
        return item;
    }
}

class OverviewItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly kind: 'action' | 'providers' | 'provider'
    ) {
        super(label, collapsibleState);
    }
}
