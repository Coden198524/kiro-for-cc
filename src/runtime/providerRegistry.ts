import { AgentProviderConfig, AgentProviderId } from './agentRuntime';
import { getRuntimeProviderSettings, getRuntimeValue } from './runtimeSettings';

const PROVIDER_IDS: AgentProviderId[] = ['claude', 'codex', 'deepseek', 'glm', 'custom'];

const CLAUDE_CAPABILITIES = {
    permissions: true,
    expertAgents: true,
    claudeAgents: true,
    claudeHooks: true,
    claudeMcp: true,
    extensionMcp: true,
    headless: true,
    interactiveSpecWorkflow: true
};

const CLI_CAPABILITIES = {
    permissions: false,
    expertAgents: false,
    claudeAgents: false,
    claudeHooks: false,
    claudeMcp: false,
    extensionMcp: true,
    headless: true,
    interactiveSpecWorkflow: false
};

const CODEX_CAPABILITIES = {
    ...CLI_CAPABILITIES,
    expertAgents: true,
    interactiveSpecWorkflow: true
};

export function isAgentProviderId(value: string | undefined): value is AgentProviderId {
    return !!value && PROVIDER_IDS.includes(value as AgentProviderId);
}

export function getActiveProviderId(): AgentProviderId {
    const configured = getRuntimeValue<string>('agent.provider', 'claude');
    return isAgentProviderId(configured) ? configured : 'claude';
}

export function getProviderConfig(providerId: AgentProviderId = getActiveProviderId()): AgentProviderConfig {
    const providerSettings = getRuntimeProviderSettings(providerId);
    const model = getRuntimeValue<string>('agent.model', '').trim() || undefined;

    switch (providerId) {
        case 'claude':
            return {
                id: 'claude',
                displayName: 'Claude Code',
                command: getRuntimeValue<string>('providers.claude.command', getRuntimeValue<string>('claudePath', providerSettings.command ?? 'claude')),
                model,
                capabilities: { ...CLAUDE_CAPABILITIES }
            };
        case 'codex':
            return {
                id: 'codex',
                displayName: 'Codex',
                command: getRuntimeValue<string>('providers.codex.command', providerSettings.command ?? 'codex'),
                model,
                args: readStringArray('providers.codex.args', providerSettings.args),
                capabilities: { ...CODEX_CAPABILITIES }
            };
        case 'deepseek':
            return {
                id: 'deepseek',
                displayName: 'DeepSeek',
                command: getRuntimeValue<string>('providers.deepseek.command', providerSettings.command ?? 'deepseek'),
                model,
                args: readStringArray('providers.deepseek.args', providerSettings.args),
                capabilities: { ...CLI_CAPABILITIES }
            };
        case 'glm':
            return {
                id: 'glm',
                displayName: 'GLM',
                command: getRuntimeValue<string>('providers.glm.command', providerSettings.command ?? 'glm'),
                model,
                args: readStringArray('providers.glm.args', providerSettings.args),
                capabilities: { ...CLI_CAPABILITIES }
            };
        case 'custom':
            return {
                id: 'custom',
                displayName: getRuntimeValue<string>('providers.custom.displayName', providerSettings.displayName ?? 'Custom Agent'),
                command: getRuntimeValue<string>('providers.custom.command', providerSettings.command ?? 'agent'),
                model,
                commandTemplate: getRuntimeValue<string>('providers.custom.commandTemplate', providerSettings.commandTemplate ?? '{command} {args} "{prompt}"'),
                args: readStringArray('providers.custom.args', providerSettings.args),
                capabilities: { ...CLI_CAPABILITIES }
            };
    }
}

function readStringArray(key: string, fallback: string[] = []): string[] {
    const value = getRuntimeValue<string[]>(key, fallback);
    return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length > 0) : [];
}

export function getProviderDisplayName(providerId: AgentProviderId = getActiveProviderId()): string {
    return getProviderConfig(providerId).displayName;
}

export function listProviderIds(): AgentProviderId[] {
    return [...PROVIDER_IDS];
}
