import * as vscode from 'vscode';
import { CONFIG_FILE_NAME, DEFAULT_PATHS, VSC_CONFIG_NAMESPACE } from '../../constants';
import { AgentProviderId } from '../../runtime/agentRuntime';
import { getProviderDisplayName, isAgentProviderId, listProviderIds } from '../../runtime/providerRegistry';
import { getRuntimeValue } from '../../runtime/runtimeSettings';
import { AutoCodeSettings, ConfigManager } from '../../utils/configManager';
import { AutoCodeUiLanguage, localize } from '../../utils/localization';

export type DevelopmentSpeedPresetId = 'fast' | 'standard' | 'strict';

interface DevelopmentSpeedPreset {
    id: DevelopmentSpeedPresetId;
    label: string;
    description: string;
    settings: Pick<AutoCodeSettings['spec'], 'deferTaskVerification' | 'taskCompletionVerificationMode' | 'autoMarkTaskDone'>;
}

const DEVELOPMENT_SPEED_PRESETS: DevelopmentSpeedPreset[] = [
    {
        id: 'fast',
        label: 'Fast',
        description: 'Defer per-task verification and keep the queue moving quickly',
        settings: {
            deferTaskVerification: true,
            taskCompletionVerificationMode: 'fast',
            autoMarkTaskDone: true
        }
    },
    {
        id: 'standard',
        label: 'Standard',
        description: 'Run focused task checks and trust completion signals',
        settings: {
            deferTaskVerification: false,
            taskCompletionVerificationMode: 'fast',
            autoMarkTaskDone: true
        }
    },
    {
        id: 'strict',
        label: 'Strict',
        description: 'Run visible model verification before marking tasks done',
        settings: {
            deferTaskVerification: false,
            taskCompletionVerificationMode: 'strict',
            autoMarkTaskDone: true
        }
    }
];

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
            currentWork: config.get('views.currentWork.visible', true),
            specs: config.get('views.specs.visible', true),
            agents: config.get('views.agents.visible', true),
            iterations: config.get('views.iterations.visible', true),
            memory: config.get('views.memory.visible', true),
            hooks: config.get('views.hooks.visible', true),
            steering: config.get('views.steering.visible', true),
            mcp: config.get('views.mcp.visible', true)
        };

        const items = [
            {
                label: `$(${currentVisibility.currentWork ? 'check' : 'blank'}) Current Work`,
                picked: currentVisibility.currentWork,
                id: 'currentWork'
            },
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
                label: `$(${currentVisibility.iterations ? 'check' : 'blank'}) Iterations`,
                picked: currentVisibility.iterations,
                id: 'iterations'
            },
            {
                label: `$(${currentVisibility.memory ? 'check' : 'blank'}) Memory`,
                picked: currentVisibility.memory,
                id: 'memory'
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
            currentWork: selected.some(item => item.id === 'currentWork'),
            specs: selected.some(item => item.id === 'specs'),
            agents: selected.some(item => item.id === 'agents'),
            iterations: selected.some(item => item.id === 'iterations'),
            memory: selected.some(item => item.id === 'memory'),
            hooks: selected.some(item => item.id === 'hooks'),
            steering: selected.some(item => item.id === 'steering'),
            mcp: selected.some(item => item.id === 'mcp')
        };

        await config.update('views.currentWork.visible', newVisibility.currentWork, vscode.ConfigurationTarget.Workspace);
        await config.update('views.specs.visible', newVisibility.specs, vscode.ConfigurationTarget.Workspace);
        await config.update('views.agents.visible', newVisibility.agents, vscode.ConfigurationTarget.Workspace);
        await config.update('views.iterations.visible', newVisibility.iterations, vscode.ConfigurationTarget.Workspace);
        await config.update('views.memory.visible', newVisibility.memory, vscode.ConfigurationTarget.Workspace);
        await config.update('views.hooks.visible', newVisibility.hooks, vscode.ConfigurationTarget.Workspace);
        await config.update('views.steering.visible', newVisibility.steering, vscode.ConfigurationTarget.Workspace);
        await config.update('views.mcp.visible', newVisibility.mcp, vscode.ConfigurationTarget.Workspace);

        const configManager = ConfigManager.getInstance();
        const settings = configManager.getSettings();
        await configManager.saveSettings({
            ...settings,
            views: {
                ...settings.views,
                currentWork: { visible: newVisibility.currentWork },
                specs: { visible: newVisibility.specs },
                agents: { visible: newVisibility.agents },
                iterations: { visible: newVisibility.iterations },
                memory: { visible: newVisibility.memory },
                hooks: { visible: newVisibility.hooks },
                steering: { visible: newVisibility.steering },
                mcp: { visible: newVisibility.mcp }
            }
        });

        vscode.window.showInformationMessage('View visibility updated!');
    }

    async selectDevelopmentSpeedPreset(): Promise<boolean> {
        const activePresetId = await this.getDevelopmentSpeedPreset();
        const selected = await vscode.window.showQuickPick(DEVELOPMENT_SPEED_PRESETS.map(preset => ({
            label: preset.id === activePresetId ? `$(check) ${preset.label}` : preset.label,
            description: this.getPresetDescription(preset.id),
            detail: preset.description,
            presetId: preset.id
        })), {
            placeHolder: localize('Select development speed preset', '选择开发速度预设')
        });

        if (!selected) {
            return false;
        }

        return this.applyDevelopmentSpeedPreset(selected.presetId);
    }

    async applyDevelopmentSpeedPreset(presetId: DevelopmentSpeedPresetId): Promise<boolean> {
        const preset = DEVELOPMENT_SPEED_PRESETS.find(item => item.id === presetId);
        if (!preset) {
            vscode.window.showErrorMessage(localize(
                `Unsupported development speed preset: ${presetId}`,
                `不支持的开发速度预设：${presetId}`
            ));
            return false;
        }

        const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
        await config.update('spec.deferTaskVerification', preset.settings.deferTaskVerification, vscode.ConfigurationTarget.Workspace);
        await config.update('spec.taskCompletionVerificationMode', preset.settings.taskCompletionVerificationMode, vscode.ConfigurationTarget.Workspace);
        await config.update('spec.autoMarkTaskDone', preset.settings.autoMarkTaskDone, vscode.ConfigurationTarget.Workspace);

        const configManager = ConfigManager.getInstance();
        await configManager.loadSettings();
        const settings = configManager.getSettings();
        await configManager.saveSettings({
            ...settings,
            spec: {
                ...settings.spec,
                ...preset.settings
            }
        });

        vscode.window.showInformationMessage(localize(
            `Development speed preset: ${preset.label}`,
            `开发速度预设：${this.getPresetDescription(preset.id)}`
        ));
        return true;
    }

    async getDevelopmentSpeedPreset(): Promise<DevelopmentSpeedPresetId> {
        await ConfigManager.getInstance().loadSettings();
        const deferVerification = getRuntimeValue<boolean>('spec.deferTaskVerification', false);
        const verificationMode = getRuntimeValue<'fast' | 'strict'>('spec.taskCompletionVerificationMode', 'fast');
        if (deferVerification) {
            return 'fast';
        }

        return verificationMode === 'strict' ? 'strict' : 'standard';
    }

    async selectUiLanguage(): Promise<boolean> {
        const current = vscode.workspace
            .getConfiguration(VSC_CONFIG_NAMESPACE)
            .get<AutoCodeUiLanguage>('ui.language', 'auto');
        const selected = await vscode.window.showQuickPick([
            {
                label: current === 'auto' ? '$(check) Auto' : 'Auto',
                description: 'Use VS Code display language',
                language: 'auto' as const
            },
            {
                label: current === 'en' ? '$(check) English' : 'English',
                description: 'Use English for AutoCode UI text',
                language: 'en' as const
            },
            {
                label: current === 'zh-CN' ? '$(check) 中文' : '中文',
                description: '使用中文显示 AutoCode 界面文本',
                language: 'zh-CN' as const
            }
        ], {
            placeHolder: localize('Select AutoCode UI language', '选择 AutoCode 界面语言')
        });

        if (!selected) {
            return false;
        }

        return this.applyUiLanguage(selected.language);
    }

    async applyUiLanguage(language: AutoCodeUiLanguage): Promise<boolean> {
        if (!['auto', 'en', 'zh-CN'].includes(language)) {
            vscode.window.showErrorMessage(`Unsupported AutoCode UI language: ${language}`);
            return false;
        }

        const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
        await config.update('ui.language', language, vscode.ConfigurationTarget.Workspace);

        const configManager = ConfigManager.getInstance();
        await configManager.loadSettings();
        const settings = configManager.getSettings();
        await configManager.saveSettings({
            ...settings,
            ui: {
                ...settings.ui,
                language
            }
        });

        vscode.window.showInformationMessage(localize(
            'AutoCode UI language updated.',
            'AutoCode 界面语言已更新。'
        ));
        return true;
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

    private getPresetDescription(presetId: DevelopmentSpeedPresetId): string {
        switch (presetId) {
            case 'fast':
                return localize('Fast', '快速');
            case 'standard':
                return localize('Standard', '标准');
            case 'strict':
                return localize('Strict', '严格');
        }
    }
}
