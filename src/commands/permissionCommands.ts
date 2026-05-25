import * as vscode from 'vscode';
import { AgentRuntime } from '../runtime/agentRuntime';
import { PermissionManager } from '../features/permission/permissionManager';
import { NotificationUtils } from '../utils/notificationUtils';

export interface RegisterPermissionCommandsOptions {
    context: vscode.ExtensionContext;
    agentRuntime: AgentRuntime;
    permissionManager: PermissionManager;
    outputChannel: vscode.OutputChannel;
}

export function registerPermissionCommands(options: RegisterPermissionCommandsOptions): void {
    const { context, agentRuntime, permissionManager, outputChannel } = options;

    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.permission.reset', async () => {
            await agentRuntime.refreshProvider?.();

            if (!agentRuntime.provider.capabilities.permissions) {
                vscode.window.showInformationMessage(`Permissions are not required for ${agentRuntime.provider.displayName}.`);
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                'Are you sure you want to reset Claude Code permissions? This will revoke the granted permissions.',
                'Yes', 'No'
            );

            if (confirm === 'Yes') {
                const success = await permissionManager.resetPermission();
                if (success) {
                    NotificationUtils.showAutoDismissNotification('Permissions have been reset');
                } else {
                    vscode.window.showErrorMessage('Failed to reset permissions. Please check the output log.');
                }
            }
        }),
        vscode.commands.registerCommand('autocode.permission.check', async () => {
            await agentRuntime.refreshProvider?.();

            if (!agentRuntime.provider.capabilities.permissions) {
                vscode.window.showInformationMessage(`Permissions are not required for ${agentRuntime.provider.displayName}.`);
                return;
            }

            const hasPermission = await permissionManager.checkPermission();
            const configPath = require('os').homedir() + '/.claude.json';

            vscode.window.showInformationMessage(`Claude Code Permission Status: ${hasPermission ? 'Granted' : 'Not Granted'}`);

            outputChannel.appendLine(`[Permission Check] Status: ${hasPermission}`);
            outputChannel.appendLine(`[Permission Check] Config file: ${configPath}`);
            outputChannel.appendLine('[Permission Check] Checking bypassPermissionsModeAccepted field in ~/.claude.json');
        })
    );
}
