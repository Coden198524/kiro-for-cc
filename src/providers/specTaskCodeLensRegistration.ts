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
    outputChannel.appendLine('CodeLens provider for spec tasks registered');
}
