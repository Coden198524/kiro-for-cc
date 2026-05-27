import * as vscode from 'vscode';
import * as path from 'path';
import { DEFAULT_PATHS, CONFIG_FILE_NAME, DEFAULT_VIEW_VISIBILITY, LEGACY_CONFIG_FILE_NAME, LEGACY_PATHS } from '../constants';

export interface AutoCodeSettings {
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
    spec: {
        autoMarkTaskDone: boolean;
        taskCompletionVerificationMode: 'fast' | 'strict';
        autoMarkTaskDoneMinConfidence: number;
        deferTaskVerification: boolean;
    };
    ui: {
        language: 'auto' | 'en' | 'zh-CN';
    };
    memory: {
        enabled: boolean;
        autoWrite: boolean;
        maxPromptItems: number;
        maxPromptChars: number;
        includeUserPreferences: boolean;
        embeddingProvider: 'none' | 'openai' | 'custom';
    };
    promptFileRetentionDays: number;
    terminalReadyTimeoutMs: number;
    paths: {
        specs: string;
        steering: string;
        settings: string;
    };
    views: {
        currentWork: { visible: boolean };
        specs: { visible: boolean };
        agents: { visible: boolean };
        steering: { visible: boolean };
        mcp: { visible: boolean };
        hooks: { visible: boolean };
        settings: { visible: boolean };
        memory: { visible: boolean };
        iterations: { visible: boolean };
    };
}

export interface ProviderSettings {
    command?: string;
    args?: string[];
    sandboxMode?: string;
    autoTaskSandboxMode?: string;
    interactiveSubmitDelayMinMs?: number;
    interactiveSubmitDelayMaxMs?: number;
    interactiveSubmitDelayCharsPerMs?: number;
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
    private settings: AutoCodeSettings | null = null;
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

    async loadSettings(): Promise<AutoCodeSettings> {
        if (!this.workspaceFolder) {
            return this.getDefaultSettings();
        }

        const settingsPath = this.getSettingsFilePath();
        const legacySettingsPath = this.getLegacySettingsFilePath();

        try {
            const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(settingsPath));
            const settings = JSON.parse(Buffer.from(fileContent).toString()) as Partial<AutoCodeSettings>;
            this.settings = this.mergeSettings(settings);
            return this.settings!;
        } catch (error) {
            try {
                const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(legacySettingsPath));
                const settings = JSON.parse(Buffer.from(fileContent).toString()) as Partial<AutoCodeSettings>;
                this.settings = this.mergeSettings(this.migrateLegacySettings(settings));
                return this.settings!;
            } catch {
                // Return default settings if neither settings file exists
                this.settings = this.getDefaultSettings();
                return this.settings!;
            }
        }
    }

    getSettings(): AutoCodeSettings {
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

    private getDefaultSettings(): AutoCodeSettings {
        return {
            agent: {
                provider: 'claude',
                model: ''
            },
            providers: {
                claude: { command: 'claude' },
                codex: {
                    command: 'codex',
                    args: [],
                    sandboxMode: '',
                    autoTaskSandboxMode: 'danger-full-access',
                    interactiveSubmitDelayMinMs: 1200,
                    interactiveSubmitDelayMaxMs: 6000,
                    interactiveSubmitDelayCharsPerMs: 12
                },
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
            spec: {
                autoMarkTaskDone: true,
                taskCompletionVerificationMode: 'fast',
                autoMarkTaskDoneMinConfidence: 0.8,
                deferTaskVerification: false
            },
            ui: {
                language: 'auto'
            },
            memory: {
                enabled: true,
                autoWrite: true,
                maxPromptItems: 8,
                maxPromptChars: 12000,
                includeUserPreferences: true,
                embeddingProvider: 'none'
            },
            promptFileRetentionDays: 7,
            terminalReadyTimeoutMs: 3000,
            paths: { ...DEFAULT_PATHS },
            views: {
                currentWork: { visible: DEFAULT_VIEW_VISIBILITY.currentWork },
                specs: { visible: DEFAULT_VIEW_VISIBILITY.specs },
                agents: { visible: DEFAULT_VIEW_VISIBILITY.agents },
                steering: { visible: DEFAULT_VIEW_VISIBILITY.steering },
                mcp: { visible: DEFAULT_VIEW_VISIBILITY.mcp },
                hooks: { visible: DEFAULT_VIEW_VISIBILITY.hooks },
                settings: { visible: DEFAULT_VIEW_VISIBILITY.settings },
                memory: { visible: DEFAULT_VIEW_VISIBILITY.memory },
                iterations: { visible: DEFAULT_VIEW_VISIBILITY.iterations }
            }
        };
    }

    private mergeSettings(settings: Partial<AutoCodeSettings>): AutoCodeSettings {
        const defaults = this.getDefaultSettings();
        const providerSettings = settings.providers ?? {};
        const viewSettings: Partial<AutoCodeSettings['views']> = settings.views ?? {};

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
            spec: {
                ...defaults.spec,
                ...(settings.spec ?? {})
            },
            ui: {
                ...defaults.ui,
                ...(settings.ui ?? {})
            },
            memory: {
                ...defaults.memory,
                ...(settings.memory ?? {})
            },
            paths: {
                ...defaults.paths,
                ...(settings.paths ?? {})
            },
            views: {
                currentWork: {
                    ...defaults.views.currentWork,
                    ...(viewSettings.currentWork ?? {})
                },
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
                },
                memory: {
                    ...defaults.views.memory,
                    ...(viewSettings.memory ?? {})
                },
                iterations: {
                    ...defaults.views.iterations,
                    ...(viewSettings.iterations ?? {})
                }
            }
        };
    }

    async saveSettings(settings: AutoCodeSettings): Promise<void> {
        if (!this.workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        const settingsDir = path.join(this.workspaceFolder.uri.fsPath, DEFAULT_PATHS.settings);
        const settingsPath = this.getSettingsFilePath();

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

    getSettingsFilePath(): string {
        if (!this.workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        return path.join(this.workspaceFolder.uri.fsPath, DEFAULT_PATHS.settings, CONFIG_FILE_NAME);
    }

    private getLegacySettingsFilePath(): string {
        if (!this.workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        return path.join(this.workspaceFolder.uri.fsPath, LEGACY_PATHS.settings, LEGACY_CONFIG_FILE_NAME);
    }

    private migrateLegacySettings(settings: Partial<AutoCodeSettings>): Partial<AutoCodeSettings> {
        const paths = settings.paths;
        if (!paths) {
            return settings;
        }

        return {
            ...settings,
            paths: {
                ...paths,
                specs: paths.specs === LEGACY_PATHS.specs ? DEFAULT_PATHS.specs : paths.specs,
                steering: paths.steering === LEGACY_PATHS.steering ? DEFAULT_PATHS.steering : paths.steering,
                settings: paths.settings === LEGACY_PATHS.settings ? DEFAULT_PATHS.settings : paths.settings
            }
        };
    }
}
