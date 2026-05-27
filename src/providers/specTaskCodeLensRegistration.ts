import * as vscode from 'vscode';
import { DEFAULT_PATHS } from '../constants';
import { ConfigManager } from '../utils/configManager';
import { SpecTaskCodeLensProvider } from './specTaskCodeLensProvider';

export async function registerSpecTaskCodeLens(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const specTaskCodeLensProvider = new SpecTaskCodeLensProvider();

    let specDir: string = DEFAULT_PATHS.specs;
    try {
        await configManager.loadSettings();
        const configuredSpecDir = configManager.getPath('specs');
        specDir = configuredSpecDir || specDir;
    } catch (error) {
        outputChannel.appendLine(`Failed to load settings for spec CodeLens: ${error}`);
    }

    const normalizedSpecDir = specDir.replace(/\\/g, '/');
    const selector: vscode.DocumentSelector = [
        {
            language: 'markdown',
            pattern: `**/${normalizedSpecDir}/*/tasks.md`,
            scheme: 'file'
        }
    ];

    context.subscriptions.push(vscode.languages.registerCodeLensProvider(selector, specTaskCodeLensProvider));
    registerSpecTaskQueueCodeLensRefreshWatchers(context, normalizedSpecDir, specTaskCodeLensProvider, outputChannel);
    outputChannel.appendLine('CodeLens provider for spec tasks registered');
}

function registerSpecTaskQueueCodeLensRefreshWatchers(
    context: vscode.ExtensionContext,
    normalizedSpecDir: string,
    provider: SpecTaskCodeLensProvider,
    outputChannel: vscode.OutputChannel
): void {
    const watcherPatterns = [
        `**/${normalizedSpecDir}/*/.autocode/task-queue.json`,
        `**/${normalizedSpecDir}/*/.autocode/task-queue.lock`,
        `**/${normalizedSpecDir}/*/.autocode/task-completion-*.json`
    ];
    let refreshTimer: NodeJS.Timeout | undefined;

    const queueRefresh = (event: string, uri: vscode.Uri | undefined) => {
        outputChannel.appendLine(`[CodeLens] ${event}: ${uri?.fsPath ?? '(unknown queue file)'}`);
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }

        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            provider.refresh();
        }, 250);
        refreshTimer.unref?.();
    };

    const watchers = watcherPatterns.map(pattern => {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidCreate(uri => queueRefresh('Create', uri));
        watcher.onDidChange(uri => queueRefresh('Change', uri));
        watcher.onDidDelete(uri => queueRefresh('Delete', uri));
        return watcher;
    });

    context.subscriptions.push(...watchers, {
        dispose: () => {
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
        }
    });
}
