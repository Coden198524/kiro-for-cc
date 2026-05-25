import { AgentProviderConfig } from './agentRuntime';

interface PromptCommandOptions {
    platform?: NodeJS.Platform;
    useWslPaths?: boolean;
}

interface BuildAgentCommandOptions extends PromptCommandOptions {
    provider: AgentProviderConfig;
    promptFilePath: string;
}

export function buildAgentCommand(options: BuildAgentCommandOptions): string {
    const { provider, promptFilePath } = options;
    const promptSubstitution = buildPromptSubstitution(promptFilePath, options);
    const args = buildArgs(provider);
    const command = quoteCommand(provider.command, provider.displayName);

    if (provider.id === 'claude') {
        return `${command} --permission-mode bypassPermissions "${promptSubstitution}"`;
    }

    if (provider.id === 'codex') {
        return `${buildPromptReadCommand(promptFilePath, options)} | ${command} exec ${args} -`.replace(/\s+/g, ' ').trim();
    }

    if (provider.commandTemplate) {
        const model = provider.model ? quoteShellArg(provider.model) : '';
        return provider.commandTemplate
            .replaceAll('{command}', command)
            .replaceAll('{args}', args)
            .replaceAll('{model}', model)
            .replaceAll('{prompt}', promptSubstitution)
            .replace(/\s+/g, ' ')
            .trim();
    }

    return [command, args, `"${promptSubstitution}"`].filter(Boolean).join(' ');
}

export function buildAgentInteractiveCommand(provider: AgentProviderConfig): string {
    const args = buildArgs(provider);

    if (provider.id === 'claude') {
        return `${quoteCommand(provider.command, provider.displayName)} --permission-mode bypassPermissions`;
    }

    return [quoteCommand(provider.command, provider.displayName), args].filter(Boolean).join(' ');
}

export function buildPromptSubstitution(promptFilePath: string, options: PromptCommandOptions = {}): string {
    if (shouldUsePowerShellPrompt(options)) {
        return `$(Get-Content -Raw -LiteralPath '${escapePowerShellSingleQuoted(promptFilePath)}')`;
    }

    return `$(cat "${escapeDoubleQuoted(promptFilePath)}")`;
}

export function buildPromptReadCommand(promptFilePath: string, options: PromptCommandOptions = {}): string {
    if (shouldUsePowerShellPrompt(options)) {
        return `Get-Content -Raw -LiteralPath '${escapePowerShellSingleQuoted(promptFilePath)}'`;
    }

    return `cat "${escapeDoubleQuoted(promptFilePath)}"`;
}

export function convertPathForWsl(filePath: string, options: PromptCommandOptions = {}): string {
    if (options.platform === 'win32' && options.useWslPaths && filePath.match(/^[A-Za-z]:\\/)) {
        let wslPath = filePath.replace(/\\/g, '/');
        wslPath = wslPath.replace(/^([A-Za-z]):/, (_match, drive) => `/mnt/${drive.toLowerCase()}`);
        return wslPath;
    }

    return filePath;
}

export function quoteCommand(command: string, displayName = 'provider'): string {
    if (!command.trim()) {
        throw new Error(`No command configured for ${displayName}`);
    }

    if (/^[A-Za-z0-9_.:/\\-]+$/.test(command)) {
        return command;
    }

    return quoteShellArg(command);
}

export function quoteShellArg(value: string): string {
    if (/^[A-Za-z0-9_./:@=+\-]+$/.test(value)) {
        return value;
    }

    return `"${escapeDoubleQuoted(value)}"`;
}

function buildArgs(provider: AgentProviderConfig): string {
    return (provider.args ?? []).map(arg => quoteShellArg(arg)).join(' ');
}

function shouldUsePowerShellPrompt(options: PromptCommandOptions): boolean {
    return (options.platform ?? process.platform) === 'win32' && !options.useWslPaths;
}

function escapeDoubleQuoted(value: string): string {
    return value.replace(/(["`$\\])/g, '\\$1');
}

function escapePowerShellSingleQuoted(value: string): string {
    return value.replace(/'/g, "''");
}
