import * as vscode from 'vscode';
import { CONFIG_FILE_NAME, DEFAULT_PATHS, VSC_CONFIG_NAMESPACE } from '../../constants';
import { AgentProviderId } from '../../runtime/agentRuntime';
import { getProviderDisplayName, isAgentProviderId, listProviderIds } from '../../runtime/providerRegistry';
import { ConfigManager } from '../../utils/configManager';

export class SettingsManager {
    constructor(private outputChannel: vscode.OutputChannel) { }

    async initializeDefaultSettings(): Promise<void> {
        await this.ensureSettingsFile();
    }

    async ensureSettingsFile(): Promise<vscode.Uri | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }

        const autocodeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.autocode');
        const settingsDir = vscode.Uri.joinPath(workspaceFolder.uri, ...DEFAULT_PATHS.settings.split('/'));

        try {
            await vscode.workspace.fs.createDirectory(autocodeDir);
            await vscode.workspace.fs.createDirectory(settingsDir);
        } catch {
            // Directories may already exist.
        }

        const settingsFile = vscode.Uri.joinPath(settingsDir, CONFIG_FILE_NAME);
        const configManager = ConfigManager.getInstance();

        try {
            await vscode.workspace.fs.stat(settingsFile);
        } catch {
            await configManager.loadSettings();
            await configManager.saveSettings(configManager.getSettings());
            return settingsFile;
        }

        try {
            const fileContent = await vscode.workspace.fs.readFile(settingsFile);
            JSON.parse(Buffer.from(fileContent).toString());
            await configManager.loadSettings();
            await configManager.saveSettings(configManager.getSettings());
        } catch (error) {
            this.outputChannel.appendLine(`[Settings] Existing settings file is not valid JSON: ${error}`);
        }

        return settingsFile;
    }

    async toggleViews(): Promise<void> {
        const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
        const currentVisibility = {
            specs: config.get('views.specs.visible', true),
            agents: config.get('views.agents.visible', true),
            hooks: config.get('views.hooks.visible', true),
            steering: config.get('views.steering.visible', true),
            mcp: config.get('views.mcp.visible', true)
        };

        const items = [
            {
                label: `$(${currentVisibility.specs ? 'check' : 'blank'}) Specs`,
                picked: currentVisibility.specs,
                id: 'specs'
            },
            {
                label: `$(${currentVisibility.agents ? 'check' : 'blank'}) Agents`,
                picked: currentVisibility.agents,
                id: 'agents'
            },
            {
                label: `$(${currentVisibility.hooks ? 'check' : 'blank'}) Agent Hooks`,
                picked: currentVisibility.hooks,
                id: 'hooks'
            },
            {
                label: `$(${currentVisibility.steering ? 'check' : 'blank'}) Agent Steering`,
                picked: currentVisibility.steering,
                id: 'steering'
            },
            {
                label: `$(${currentVisibility.mcp ? 'check' : 'blank'}) MCP Servers`,
                picked: currentVisibility.mcp,
                id: 'mcp'
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: 'Select views to show'
        });

        if (!selected) {
            return;
        }

        const newVisibility = {
            specs: selected.some(item => item.id === 'specs'),
            agents: selected.some(item => item.id === 'agents'),
            hooks: selected.some(item => item.id === 'hooks'),
            steering: selected.some(item => item.id === 'steering'),
            mcp: selected.some(item => item.id === 'mcp')
        };

        await config.update('views.specs.visible', newVisibility.specs, vscode.ConfigurationTarget.Workspace);
        await config.update('views.agents.visible', newVisibility.agents, vscode.ConfigurationTarget.Workspace);
        await config.update('views.hooks.visible', newVisibility.hooks, vscode.ConfigurationTarget.Workspace);
        await config.update('views.steering.visible', newVisibility.steering, vscode.ConfigurationTarget.Workspace);
        await config.update('views.mcp.visible', newVisibility.mcp, vscode.ConfigurationTarget.Workspace);

        const configManager = ConfigManager.getInstance();
        const settings = configManager.getSettings();
        await configManager.saveSettings({
            ...settings,
            views: {
                ...settings.views,
                specs: { visible: newVisibility.specs },
                agents: { visible: newVisibility.agents },
                hooks: { visible: newVisibility.hooks },
                steering: { visible: newVisibility.steering },
                mcp: { visible: newVisibility.mcp }
            }
        });

        vscode.window.showInformationMessage('View visibility updated!');
    }

    async selectAgentProvider(): Promise<boolean> {
        const activeProvider = await this.getActiveProvider();
        const items = listProviderIds().map(providerId => ({
            label: getProviderDisplayName(providerId),
            description: providerId === activeProvider ? 'Active' : providerId,
            providerId
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select active model provider'
        });
        if (!selected) {
            return false;
        }

        return this.setAgentProvider(selected.providerId);
    }

    async setAgentProvider(providerId: AgentProviderId | string): Promise<boolean> {
        if (!isAgentProviderId(providerId)) {
            vscode.window.showErrorMessage(`Unsupported model provider: ${providerId}`);
            return false;
        }

        await this.updateAgentSettings({ provider: providerId });
        vscode.window.showInformationMessage(`Active model provider: ${getProviderDisplayName(providerId)}`);
        return true;
    }

    async setAgentModel(): Promise<boolean> {
        const currentModel = await this.getActiveModel();
        const model = await vscode.window.showInputBox({
            title: 'Set Active Model',
            prompt: 'Enter a model ID, or leave empty to use the provider default',
            placeHolder: 'Provider default',
            value: currentModel
        });

        if (model === undefined) {
            return false;
        }

        await this.updateAgentSettings({ model: model.trim() });
        vscode.window.showInformationMessage(model.trim() ? `Active model: ${model.trim()}` : 'Active model cleared; using provider default.');
        return true;
    }

    async clearAgentModel(): Promise<boolean> {
        await this.updateAgentSettings({ model: '' });
        vscode.window.showInformationMessage('Active model cleared; using provider default.');
        return true;
    }

    private async getActiveProvider(): Promise<AgentProviderId> {
        const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
        const configured = config.get<string>('agent.provider', '');
        if (isAgentProviderId(configured)) {
            return configured;
        }

        await ConfigManager.getInstance().loadSettings();
        const projectProvider = ConfigManager.getInstance().getSettings().agent.provider;
        return isAgentProviderId(projectProvider) ? projectProvider : 'claude';
    }

    private async getActiveModel(): Promise<string> {
        const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
        const configured = config.get<string>('agent.model', '');
        if (configured) {
            return configured;
        }

        await ConfigManager.getInstance().loadSettings();
        return ConfigManager.getInstance().getSettings().agent.model ?? '';
    }

    private async updateAgentSettings(agentSettings: { provider?: AgentProviderId; model?: string }): Promise<void> {
        const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
        if (agentSettings.provider !== undefined) {
            await config.update('agent.provider', agentSettings.provider, vscode.ConfigurationTarget.Workspace);
        }
        if (agentSettings.model !== undefined) {
            await config.update('agent.model', agentSettings.model, vscode.ConfigurationTarget.Workspace);
        }

        const configManager = ConfigManager.getInstance();
        await configManager.loadSettings();
        const settings = configManager.getSettings();
        await configManager.saveSettings({
            ...settings,
            agent: {
                ...settings.agent,
                ...agentSettings
            }
        });
    }
}
