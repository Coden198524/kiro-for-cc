import * as vscode from 'vscode';
import * as path from 'path';
import { DEFAULT_PATHS, CONFIG_FILE_NAME, DEFAULT_VIEW_VISIBILITY } from '../constants';

export interface KfcSettings {
    agent: {
        provider: string;
        model?: string;
    };
    providers: {
        claude?: ProviderSettings;
        codex?: ProviderSettings;
        deepseek?: ProviderSettings;
        glm?: ProviderSettings;
        custom?: ProviderSettings & {
            displayName?: string;
            commandTemplate?: string;
        };
    };
    mcp: {
        customServers: CustomMcpServerSettings[];
    };
    paths: {
        specs: string;
        steering: string;
        settings: string;
    };
    views: {
        specs: { visible: boolean };
        agents: { visible: boolean };
        steering: { visible: boolean };
        mcp: { visible: boolean };
        hooks: { visible: boolean };
        settings: { visible: boolean };
    };
}

export interface ProviderSettings {
    command?: string;
    args?: string[];
}

export interface CustomMcpServerSettings {
    id?: string;
    name?: string;
    type?: 'stdio' | 'sse' | 'http' | 'command';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    description?: string;
}

export class ConfigManager {
    private static instance: ConfigManager;
    private settings: KfcSettings | null = null;
    private workspaceFolder: vscode.WorkspaceFolder | undefined;
    
    // Internal constants
    private static readonly TERMINAL_VENV_ACTIVATION_DELAY = 800; // ms

    private constructor() {
        this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    }

    static getInstance(): ConfigManager {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager();
        }
        return ConfigManager.instance;
    }

    async loadSettings(): Promise<KfcSettings> {
        if (!this.workspaceFolder) {
            return this.getDefaultSettings();
        }

        const settingsPath = path.join(
            this.workspaceFolder.uri.fsPath,
            DEFAULT_PATHS.settings,
            CONFIG_FILE_NAME
        );

        try {
            const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(settingsPath));
            const settings = JSON.parse(Buffer.from(fileContent).toString()) as Partial<KfcSettings>;
            this.settings = this.mergeSettings(settings);
            return this.settings!;
        } catch (error) {
            // Return default settings if file doesn't exist
            this.settings = this.getDefaultSettings();
            return this.settings!;
        }
    }

    getSettings(): KfcSettings {
        if (!this.settings) {
            this.settings = this.getDefaultSettings();
        }
        return this.settings;
    }

    getPath(type: keyof typeof DEFAULT_PATHS): string {
        const settings = this.getSettings();
        const rawPath = settings.paths[type] || DEFAULT_PATHS[type];
        const normalized = this.normalizePath(rawPath);
        return normalized || this.normalizePath(DEFAULT_PATHS[type]);
    }

    /**
     * Normalizes a path for consistent matching:
     * - Removes leading ./ or .\
     * - Converts backslashes to forward slashes
     * - Collapses duplicate separators and trims trailing slashes
     */
    private normalizePath(inputPath: string): string {
        if (!inputPath) {
            return inputPath;
        }

        // Start by trimming whitespace and removing repeated leading ./ or .\
        let normalized = inputPath.trim().replace(/^(\.\/|\.\\)+/, '');

        // Normalize path separators to forward slashes for glob compatibility
        normalized = normalized.replace(/\\/g, '/');

        // Collapse any duplicate separators that may result from user input
        normalized = normalized.replace(/\/{2,}/g, '/');

        // Remove trailing slashes for consistent matching
        normalized = normalized.replace(/\/+$/, '');

        return normalized;
    }

    getAbsolutePath(type: keyof typeof DEFAULT_PATHS): string {
        if (!this.workspaceFolder) {
            throw new Error('No workspace folder found');
        }
        return path.join(this.workspaceFolder.uri.fsPath, this.getPath(type));
    }

    getTerminalDelay(): number {
        return ConfigManager.TERMINAL_VENV_ACTIVATION_DELAY;
    }

    private getDefaultSettings(): KfcSettings {
        return {
            agent: {
                provider: 'claude',
                model: ''
            },
            providers: {
                claude: { command: 'claude' },
                codex: { command: 'codex', args: [] },
                deepseek: { command: 'deepseek', args: [] },
                glm: { command: 'glm', args: [] },
                custom: {
                    displayName: 'Custom Agent',
                    command: 'agent',
                    args: [],
                    commandTemplate: '{command} {args} "{prompt}"'
                }
            },
            mcp: {
                customServers: []
            },
            paths: { ...DEFAULT_PATHS },
            views: {
                specs: { visible: DEFAULT_VIEW_VISIBILITY.specs },
                agents: { visible: DEFAULT_VIEW_VISIBILITY.agents },
                steering: { visible: DEFAULT_VIEW_VISIBILITY.steering },
                mcp: { visible: DEFAULT_VIEW_VISIBILITY.mcp },
                hooks: { visible: DEFAULT_VIEW_VISIBILITY.hooks },
                settings: { visible: DEFAULT_VIEW_VISIBILITY.settings }
            }
        };
    }

    private mergeSettings(settings: Partial<KfcSettings>): KfcSettings {
        const defaults = this.getDefaultSettings();
        const providerSettings = settings.providers ?? {};
        const viewSettings: Partial<KfcSettings['views']> = settings.views ?? {};

        return {
            ...defaults,
            ...settings,
            agent: {
                ...defaults.agent,
                ...(settings.agent ?? {}),
                provider: settings.agent?.provider ?? defaults.agent.provider
            },
            providers: {
                claude: {
                    ...defaults.providers?.claude,
                    ...(providerSettings.claude ?? {})
                },
                codex: {
                    ...defaults.providers?.codex,
                    ...(providerSettings.codex ?? {})
                },
                deepseek: {
                    ...defaults.providers?.deepseek,
                    ...(providerSettings.deepseek ?? {})
                },
                glm: {
                    ...defaults.providers?.glm,
                    ...(providerSettings.glm ?? {})
                },
                custom: {
                    ...defaults.providers?.custom,
                    ...(providerSettings.custom ?? {})
                }
            },
            mcp: {
                ...defaults.mcp,
                ...(settings.mcp ?? {}),
                customServers: settings.mcp?.customServers ?? defaults.mcp.customServers
            },
            paths: {
                ...defaults.paths,
                ...(settings.paths ?? {})
            },
            views: {
                specs: {
                    ...defaults.views.specs,
                    ...(viewSettings.specs ?? {})
                },
                agents: {
                    ...defaults.views.agents,
                    ...(viewSettings.agents ?? {})
                },
                steering: {
                    ...defaults.views.steering,
                    ...(viewSettings.steering ?? {})
                },
                mcp: {
                    ...defaults.views.mcp,
                    ...(viewSettings.mcp ?? {})
                },
                hooks: {
                    ...defaults.views.hooks,
                    ...(viewSettings.hooks ?? {})
                },
                settings: {
                    ...defaults.views.settings,
                    ...(viewSettings.settings ?? {})
                }
            }
        };
    }

    async saveSettings(settings: KfcSettings): Promise<void> {
        if (!this.workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        const settingsDir = path.join(
            this.workspaceFolder.uri.fsPath,
            DEFAULT_PATHS.settings
        );
        const settingsPath = path.join(settingsDir, CONFIG_FILE_NAME);

        // Ensure directory exists
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(settingsDir));

        const mergedSettings = this.mergeSettings(settings);

        // Save settings
        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(settingsPath),
            Buffer.from(JSON.stringify(mergedSettings, null, 2))
        );

        this.settings = mergedSettings;
    }
}
