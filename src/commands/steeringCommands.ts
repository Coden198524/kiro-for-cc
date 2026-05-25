import * as vscode from 'vscode';
import { AgentManager } from '../features/agents/agentManager';
import { SteeringManager } from '../features/steering/steeringManager';
import { AgentsExplorerProvider } from '../providers/agentsExplorerProvider';
import { SteeringExplorerProvider } from '../providers/steeringExplorerProvider';

export interface RegisterSteeringCommandsOptions {
    context: vscode.ExtensionContext;
    steeringManager: SteeringManager;
    steeringExplorer: SteeringExplorerProvider;
    agentsExplorer: AgentsExplorerProvider;
    agentManager: AgentManager;
    outputChannel: vscode.OutputChannel;
}

export function registerSteeringCommands(options: RegisterSteeringCommandsOptions): void {
    const {
        context,
        steeringManager,
        steeringExplorer,
        agentsExplorer,
        outputChannel
    } = options;

    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.steering.create', async () => {
            await steeringManager.createCustom();
        }),
        vscode.commands.registerCommand('autocode.steering.generateInitial', async () => {
            await steeringManager.init();
        }),
        vscode.commands.registerCommand('autocode.steering.refine', async (item: { resourcePath: string }) => {
            await steeringManager.refine(vscode.Uri.file(item.resourcePath));
        }),
        vscode.commands.registerCommand('autocode.steering.delete', async (item: { label: string; resourcePath: string }) => {
            outputChannel.appendLine(`[Steering] Deleting: ${item.label}`);
            const result = await steeringManager.delete(item.label, item.resourcePath);
            if (!result.success && result.error) {
                vscode.window.showErrorMessage(result.error);
            }
        }),
        vscode.commands.registerCommand('autocode.steering.createUserRule', async () => {
            await steeringManager.createUserClaudeMd();
        }),
        vscode.commands.registerCommand('autocode.steering.createProjectRule', async () => {
            await steeringManager.createProjectClaudeMd();
        }),
        vscode.commands.registerCommand('autocode.steering.refresh', async () => {
            outputChannel.appendLine('[Manual Refresh] Refreshing steering explorer...');
            steeringExplorer.refresh();
        }),
        vscode.commands.registerCommand('autocode.agents.refresh', async () => {
            outputChannel.appendLine('[Manual Refresh] Refreshing agents explorer...');
            agentsExplorer.refresh();
        })
    );
}
