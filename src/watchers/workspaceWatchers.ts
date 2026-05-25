import * as vscode from 'vscode';
import { AgentsExplorerProvider } from '../providers/agentsExplorerProvider';
import { HooksExplorerProvider } from '../providers/hooksExplorerProvider';
import { MCPExplorerProvider } from '../providers/mcpExplorerProvider';
import { SpecExplorerProvider } from '../providers/specExplorerProvider';
import { SteeringExplorerProvider } from '../providers/steeringExplorerProvider';
import { AgentRuntime } from '../runtime/agentRuntime';
import { ConfigManager } from '../utils/configManager';

export interface RegisterWorkspaceWatchersOptions {
    context: vscode.ExtensionContext;
    agentRuntime: AgentRuntime;
    specExplorer: SpecExplorerProvider;
    steeringExplorer: SteeringExplorerProvider;
    hooksExplorer: HooksExplorerProvider;
    mcpExplorer: MCPExplorerProvider;
    agentsExplorer: AgentsExplorerProvider;
    outputChannel: vscode.OutputChannel;
}

export function registerWorkspaceWatchers(options: RegisterWorkspaceWatchersOptions): void {
    const {
        context,
        agentRuntime,
        specExplorer,
        steeringExplorer,
        hooksExplorer,
        mcpExplorer,
        agentsExplorer,
        outputChannel
    } = options;

    const autocodeWatcher = vscode.workspace.createFileSystemWatcher('**/.autocode/**/*');
    let refreshTimeout: NodeJS.Timeout | undefined;

    const debouncedRefresh = (event: string, uri: vscode.Uri) => {
        outputChannel.appendLine(`[FileWatcher] ${event}: ${uri.fsPath}`);

        if (refreshTimeout) {
            clearTimeout(refreshTimeout);
        }

        refreshTimeout = setTimeout(async () => {
            await ConfigManager.getInstance().loadSettings();
            await agentRuntime.refreshProvider?.();
            specExplorer.refresh();
            steeringExplorer.refresh();
            hooksExplorer.refresh();
            mcpExplorer.refresh();
            agentsExplorer.refresh();
        }, 1000);
    };

    autocodeWatcher.onDidCreate((uri) => debouncedRefresh('Create', uri));
    autocodeWatcher.onDidDelete((uri) => debouncedRefresh('Delete', uri));
    autocodeWatcher.onDidChange((uri) => debouncedRefresh('Change', uri));

    const claudeSettingsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(process.env.HOME || '', '.claude/settings.json')
    );
    claudeSettingsWatcher.onDidChange(() => {
        hooksExplorer.refresh();
        mcpExplorer.refresh();
    });

    const globalClaudeMdWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(process.env.HOME || '', '.claude/CLAUDE.md')
    );
    const projectClaudeMdWatcher = vscode.workspace.createFileSystemWatcher('**/CLAUDE.md');

    globalClaudeMdWatcher.onDidCreate(() => steeringExplorer.refresh());
    globalClaudeMdWatcher.onDidDelete(() => steeringExplorer.refresh());
    projectClaudeMdWatcher.onDidCreate(() => steeringExplorer.refresh());
    projectClaudeMdWatcher.onDidDelete(() => steeringExplorer.refresh());

    context.subscriptions.push(
        autocodeWatcher,
        claudeSettingsWatcher,
        globalClaudeMdWatcher,
        projectClaudeMdWatcher,
        {
            dispose: () => {
                if (refreshTimeout) {
                    clearTimeout(refreshTimeout);
                }
            }
        }
    );
}
