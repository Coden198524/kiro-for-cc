import * as vscode from 'vscode';
import { SettingsManager } from '../features/settings/settingsManager';
import { CurrentWorkProvider } from '../providers/currentWorkProvider';
import { HooksExplorerProvider } from '../providers/hooksExplorerProvider';
import { MCPExplorerProvider } from '../providers/mcpExplorerProvider';
import { OverviewProvider } from '../providers/overviewProvider';
import { UpdateChecker } from '../utils/updateChecker';

export interface RegisterGeneralCommandsOptions {
    context: vscode.ExtensionContext;
    hooksExplorer: HooksExplorerProvider;
    mcpExplorer: MCPExplorerProvider;
    overviewProvider: OverviewProvider;
    currentWorkProvider?: CurrentWorkProvider;
    updateChecker: UpdateChecker;
    settingsManager: SettingsManager;
    outputChannel: vscode.OutputChannel;
}

export function registerGeneralCommands(options: RegisterGeneralCommandsOptions): void {
    const {
        context,
        hooksExplorer,
        mcpExplorer,
        overviewProvider,
        currentWorkProvider,
        updateChecker,
        settingsManager,
        outputChannel
    } = options;

    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.hooks.refresh', () => {
            hooksExplorer.refresh();
        }),
        vscode.commands.registerCommand('autocode.hooks.copyCommand', async (command: string) => {
            await vscode.env.clipboard.writeText(command);
        }),
        vscode.commands.registerCommand('autocode.mcp.refresh', () => {
            mcpExplorer.refresh();
        }),
        vscode.commands.registerCommand('autocode.model.selectProvider', async () => {
            if (await settingsManager.selectAgentProvider()) {
                overviewProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('autocode.model.useProvider', async (providerId: string) => {
            if (await settingsManager.setAgentProvider(providerId)) {
                overviewProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('autocode.model.setModel', async () => {
            if (await settingsManager.setAgentModel()) {
                overviewProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('autocode.model.clearModel', async () => {
            if (await settingsManager.clearAgentModel()) {
                overviewProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('autocode.settings.selectDevelopmentSpeedPreset', async () => {
            if (await settingsManager.selectDevelopmentSpeedPreset()) {
                currentWorkProvider?.refresh();
            }
        }),
        vscode.commands.registerCommand('autocode.settings.setUiLanguage', async () => {
            if (await settingsManager.selectUiLanguage()) {
                overviewProvider.refresh();
                currentWorkProvider?.refresh();
            }
        }),
        vscode.commands.registerCommand('autocode.currentWork.refresh', () => {
            currentWorkProvider?.refresh();
        }),
        vscode.commands.registerCommand('autocode.checkForUpdates', async () => {
            outputChannel.appendLine('Manual update check requested');
            await updateChecker.checkForUpdates(true);
        }),
        vscode.commands.registerCommand('autocode.settings.open', async () => {
            outputChannel.appendLine('Opening AutoCode settings...');

            const settingsFile = await settingsManager.ensureSettingsFile();
            if (!settingsFile) {
                vscode.window.showErrorMessage('No workspace folder found');
                return;
            }

            const document = await vscode.workspace.openTextDocument(settingsFile);
            await vscode.window.showTextDocument(document);
        }),
        vscode.commands.registerCommand('autocode.help.open', async () => {
            outputChannel.appendLine('Opening AutoCode help...');
            const helpUrl = 'https://github.com/Coden198524/autocode#readme';
            vscode.env.openExternal(vscode.Uri.parse(helpUrl));
        }),
        vscode.commands.registerCommand('autocode.menu.open', async () => {
            outputChannel.appendLine('Opening AutoCode menu...');
            await settingsManager.toggleViews();
        }),
        registerAgentFileSaveGuard()
    );
}

function registerAgentFileSaveGuard(): vscode.Disposable {
    return vscode.workspace.onWillSaveTextDocument(async (event) => {
        const document = event.document;
        const filePath = document.fileName;

        if (!filePath.includes('.autocode/agents/') || !filePath.endsWith('.md')) {
            return;
        }

        const result = await vscode.window.showWarningMessage(
            'Are you sure you want to save changes to this agent file?',
            { modal: true },
            'Save',
            'Cancel'
        );

        if (result !== 'Save') {
            event.waitUntil(new Promise(() => { }));
        }
    });
}
