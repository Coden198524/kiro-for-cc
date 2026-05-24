import * as vscode from 'vscode';
import { VSC_CONFIG_NAMESPACE } from '../constants';
import { ConfigManager, CustomMcpServerSettings } from '../utils/configManager';

export interface RuntimeProviderSettings {
    command?: string;
    args?: string[];
    displayName?: string;
    commandTemplate?: string;
}

export function getRuntimeValue<T>(section: string, defaultValue: T): T {
    const vsCodeValue = getVsCodeValue<T>(section, undefined as T | undefined);
    if (vsCodeValue !== undefined) {
        return vsCodeValue;
    }

    const projectValue = getProjectValue<T>(section);
    return projectValue !== undefined ? projectValue : defaultValue;
}

export function getRuntimeProviderSettings(providerId: string): RuntimeProviderSettings {
    const settings = ConfigManager.getInstance().getSettings();
    const providers = settings.providers as Record<string, RuntimeProviderSettings> | undefined;
    return providers?.[providerId] ?? {};
}

export function getRuntimeCustomMcpServers(): CustomMcpServerSettings[] {
    return getRuntimeValue<CustomMcpServerSettings[]>('mcp.customServers', []);
}

function getVsCodeValue<T>(section: string, defaultValue: T | undefined): T | undefined {
    if (typeof vscode.workspace.getConfiguration !== 'function') {
        return defaultValue;
    }

    const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
    if (typeof config.inspect === 'function') {
        const inspected = config.inspect<T>(section);
        if (!inspected) {
            return defaultValue;
        }

        const explicitValues: Array<T | undefined> = [
            inspected.workspaceFolderLanguageValue,
            inspected.workspaceFolderValue,
            inspected.workspaceLanguageValue,
            inspected.workspaceValue,
            inspected.globalLanguageValue,
            inspected.globalValue
        ];
        return explicitValues.find(value => value !== undefined) ?? defaultValue;
    }

    const value = config.get<T | undefined>(section, undefined);
    return value !== undefined ? value : defaultValue;
}

function getProjectValue<T>(section: string): T | undefined {
    const settings = ConfigManager.getInstance().getSettings() as unknown as Record<string, unknown>;
    const segments = section.split('.');
    let current: unknown = settings;

    for (const segment of segments) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
    }

    return current as T;
}
