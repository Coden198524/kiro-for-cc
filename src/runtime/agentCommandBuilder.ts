import { AgentApprovalPolicy, AgentProviderConfig, AgentSandboxMode } from './agentRuntime';

interface PromptCommandOptions {
    platform?: NodeJS.Platform;
    useWslPaths?: boolean;
}

export interface AgentCommandOptions {
    approvalPolicy?: AgentApprovalPolicy;
    sandboxMode?: AgentSandboxMode;
    bypassApprovalsAndSandbox?: boolean;
}

interface BuildAgentCommandOptions extends PromptCommandOptions, AgentCommandOptions {
    provider: AgentProviderConfig;
    promptFilePath: string;
}

export function buildAgentCommand(options: BuildAgentCommandOptions): string {
    const { provider, promptFilePath } = options;
    const promptSubstitution = buildPromptSubstitution(promptFilePath, options);
    const args = buildArgs(provider, options);
    const command = quoteCommand(provider.command, provider.displayName);

    if (provider.id === 'claude') {
        return `${command} --permission-mode bypassPermissions "${promptSubstitution}"`;
    }

    if (provider.id === 'codex') {
        const codexGlobalArgs = buildCodexGlobalArgs(options);
        return `${buildPromptReadCommand(promptFilePath, options)} | ${command} ${codexGlobalArgs} exec ${args} -`.replace(/\s+/g, ' ').trim();
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

export function buildAgentInteractiveCommand(provider: AgentProviderConfig, options: AgentCommandOptions = {}): string {
    const args = buildArgs(provider, options);

    if (provider.id === 'claude') {
        return `${quoteCommand(provider.command, provider.displayName)} --permission-mode bypassPermissions`;
    }

    if (provider.id === 'codex') {
        return [quoteCommand(provider.command, provider.displayName), buildCodexGlobalArgs(options), args].filter(Boolean).join(' ');
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

function buildArgs(provider: AgentProviderConfig, options: AgentCommandOptions = {}): string {
    const args = provider.id === 'codex' && hasCodexGlobalOptions(options)
        ? removeCodexGlobalArgs(provider.args ?? [])
        : provider.args ?? [];

    return args.map(arg => quoteShellArg(arg)).join(' ');
}

function buildCodexGlobalArgs(options: AgentCommandOptions): string {
    if (options.bypassApprovalsAndSandbox) {
        return '--dangerously-bypass-approvals-and-sandbox';
    }

    const args: string[] = [];
    if (options.approvalPolicy) {
        args.push('--ask-for-approval', quoteShellArg(options.approvalPolicy));
    }

    if (options.sandboxMode) {
        args.push('--sandbox', quoteShellArg(options.sandboxMode));
    }

    return args.join(' ');
}

function hasCodexGlobalOptions(options: AgentCommandOptions): boolean {
    return Boolean(options.approvalPolicy || options.sandboxMode || options.bypassApprovalsAndSandbox);
}

function removeCodexGlobalArgs(args: readonly string[]): string[] {
    const filtered: string[] = [];

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--ask-for-approval' || arg === '-a' || arg === '--sandbox' || arg === '-s') {
            index += 1;
            continue;
        }

        if (
            arg === '--dangerously-bypass-approvals-and-sandbox' ||
            arg.startsWith('--ask-for-approval=') ||
            arg.startsWith('-a=') ||
            arg.startsWith('--sandbox=') ||
            arg.startsWith('-s=')
        ) {
            continue;
        }

        filtered.push(arg);
    }

    return filtered;
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
