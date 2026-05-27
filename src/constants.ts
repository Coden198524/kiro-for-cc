// VSCode configuration namespace for this extension
export const VSC_CONFIG_NAMESPACE = 'autocode';
export const LEGACY_VSC_CONFIG_NAMESPACE = 'kfc';

// File names
export const CONFIG_FILE_NAME = 'autocode-settings.json';
export const LEGACY_CONFIG_FILE_NAME = 'kfc-settings.json';

// Default configuration
export const DEFAULT_CONFIG = {
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
        autoMarkTaskDoneMinConfidence: 0.8
    },
    memory: {
        enabled: true,
        autoWrite: true,
        maxPromptItems: 8,
        includeUserPreferences: true,
        embeddingProvider: 'none'
    },
    paths: {
        specs: '.autocode/specs',
        steering: '.autocode/steering',
        settings: '.autocode/settings'
    },
    views: {
        specs: true,
        agents: true,
        steering: true,
        mcp: true,
        hooks: true,
        settings: true,
        memory: true,
        iterations: true
    }
} as const;

// Legacy exports for backward compatibility (can be removed after updating all references)
export const DEFAULT_PATHS = DEFAULT_CONFIG.paths;
export const DEFAULT_VIEW_VISIBILITY = DEFAULT_CONFIG.views;
export const LEGACY_PATHS = {
    specs: '.claude/specs',
    steering: '.claude/steering',
    settings: '.claude/settings'
} as const;
