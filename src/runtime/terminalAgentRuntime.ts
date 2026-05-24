import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ConfigManager } from '../utils/configManager';
import { VSC_CONFIG_NAMESPACE } from '../constants';
import { getPermissionManager } from '../extension';
import { AgentType, getAgentConfig } from './agentConfigs';
import { AgentInvocationRequest, AgentInvocationResult, AgentProviderConfig, AgentRuntime } from './agentRuntime';
import { getRuntimeMcpServers, McpServerInfo } from './mcpRegistry';
import { getProviderConfig } from './providerRegistry';

const execAsync = promisify(exec);

export class TerminalAgentRuntime implements AgentRuntime {
    private static readonly INTERACTIVE_PROMPT_PASTE_DELAY = 1500;
    private static readonly INTERACTIVE_PROMPT_SUBMIT_MIN_DELAY = 500;
    private static readonly INTERACTIVE_PROMPT_SUBMIT_MAX_DELAY = 3000;
    private static readonly CODEX_INTERACTIVE_PROMPT_SUBMIT_MIN_DELAY = 3000;
    private static readonly CODEX_INTERACTIVE_PROMPT_SUBMIT_MAX_DELAY = 12000;
    private static readonly CODEX_INTERACTIVE_PROMPT_CHARS_PER_DELAY_MS = 6;
    private configManager: ConfigManager;
    private interactiveTerminal: vscode.Terminal | undefined;
    private interactiveTerminalProviderId: string | undefined;
    private interactiveTerminalStarted = false;
    private interactivePromptQueue: Promise<void> = Promise.resolve();
    private commandTerminal: vscode.Terminal | undefined;
    private commandTerminalProviderId: string | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private outputChannel: vscode.OutputChannel,
        public provider: AgentProviderConfig = getProviderConfig()
    ) {
        this.configManager = ConfigManager.getInstance();
        this.configManager.loadSettings();

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(VSC_CONFIG_NAMESPACE)) {
                this.configManager.loadSettings();
                this.provider = getProviderConfig();
            }
        });

        vscode.window.onDidCloseTerminal(terminal => {
            if (terminal === this.interactiveTerminal) {
                this.interactiveTerminal = undefined;
                this.interactiveTerminalProviderId = undefined;
                this.interactiveTerminalStarted = false;
                this.interactivePromptQueue = Promise.resolve();
            }

            if (terminal === this.commandTerminal) {
                this.commandTerminal = undefined;
                this.commandTerminalProviderId = undefined;
            }
        });
    }

    async invokeInteractive(request: AgentInvocationRequest): Promise<vscode.Terminal> {
        try {
            await this.refreshProviderConfig();
            await this.ensureProviderReady();
            const provider = this.provider;
            const prompt = this.decoratePrompt(request.prompt, request.agentType);

            if (provider.id === 'claude' || provider.id === 'codex') {
                return this.invokePromptPastedInteractive(prompt, request.title, request.reuseTerminal);
            }

            const promptFilePath = await this.createTempFile(prompt, 'prompt');
            const command = this.buildCommand(promptFilePath, provider);
            const title = request.title || `AutoCode - ${provider.displayName}`;
            const terminal = request.reuseTerminal
                ? this.getOrCreateCommandTerminal(title, provider.id)
                : this.createTerminal(title);

            terminal.show();

            const delay = this.configManager.getTerminalDelay();
            setTimeout(() => {
                terminal.sendText(command, true);
            }, delay);

            this.schedulePromptCleanup(promptFilePath, 30000);
            return terminal;
        } catch (error) {
            this.outputChannel.appendLine(`ERROR: Failed to run ${this.provider.displayName}: ${error}`);
            vscode.window.showErrorMessage(`Failed to run ${this.provider.displayName}: ${error}`);
            throw error;
        }
    }

    async invokeHeadless(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
        await this.refreshProviderConfig();
        await this.ensureProviderReady();
        const prompt = this.decoratePrompt(request.prompt, request.agentType);

        this.outputChannel.appendLine(`[AgentRuntime] Invoking ${this.provider.displayName} in headless mode`);
        this.outputChannel.appendLine('========================================');
        this.outputChannel.appendLine(prompt);
        this.outputChannel.appendLine('========================================');

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const cwd = workspaceFolder?.uri.fsPath;
        const promptFilePath = await this.createTempFile(prompt, 'background-prompt');
        const commandLine = this.buildCommand(promptFilePath);

        try {
            const { stdout, stderr } = await execAsync(commandLine, {
                cwd,
                shell: process.platform === 'win32' ? 'powershell.exe' : undefined,
                maxBuffer: 1024 * 1024 * 8
            });
            await this.cleanupPromptFile(promptFilePath);
            return {
                exitCode: 0,
                output: stdout,
                stderr
            };
        } catch (error: any) {
            await this.cleanupPromptFile(promptFilePath);
            this.outputChannel.appendLine(`[AgentRuntime] Headless command failed: ${error}`);
            return {
                exitCode: typeof error?.code === 'number' ? error.code : 1,
                output: error?.stdout,
                stderr: error?.stderr ?? String(error)
            };
        }
    }

    async renameTerminal(terminal: vscode.Terminal, newName: string): Promise<void> {
        terminal.show();
        await new Promise(resolve => setTimeout(resolve, 100));
        this.outputChannel.appendLine(`[AgentRuntime] ${terminal.name} Terminal renamed to: ${newName}`);
        await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
            name: newName
        });
    }

    async refreshProvider(): Promise<void> {
        await this.refreshProviderConfig();
    }

    private async ensureProviderReady(): Promise<void> {
        if (!this.provider.capabilities.permissions) {
            return;
        }

        const permissionManager = getPermissionManager();
        if (!permissionManager) {
            return;
        }

        const hasPermission = await permissionManager.checkPermission();
        if (!hasPermission) {
            this.outputChannel.appendLine('[AgentRuntime] Claude permission missing, showing setup');
            const granted = await permissionManager.showPermissionSetup();
            if (!granted) {
                throw new Error('Claude Code permissions not granted');
            }
        }
    }

    private async refreshProviderConfig(): Promise<void> {
        await this.configManager.loadSettings();
        this.provider = getProviderConfig();
    }

    private async invokePromptPastedInteractive(prompt: string, title?: string, reuseTerminal = false): Promise<vscode.Terminal> {
        const provider = this.provider;
        const terminal = reuseTerminal
            ? this.getOrCreateInteractiveTerminal(title, provider.id)
            : this.createTerminal(title);

        terminal.show();

        if (reuseTerminal) {
            this.enqueueInteractivePrompt(terminal, provider, prompt);
            return terminal;
        }

        const delay = this.configManager.getTerminalDelay();
        setTimeout(() => {
            terminal.sendText(this.buildInteractiveCommand(provider), true);
            setTimeout(() => this.sendPromptToInteractiveTerminal(terminal, provider, prompt), TerminalAgentRuntime.INTERACTIVE_PROMPT_PASTE_DELAY);
        }, delay);

        return terminal;
    }

    private enqueueInteractivePrompt(terminal: vscode.Terminal, provider: AgentProviderConfig, prompt: string): void {
        const run = this.interactivePromptQueue.then(() => this.runQueuedInteractivePrompt(terminal, provider, prompt));
        this.interactivePromptQueue = run.catch(error => {
            this.outputChannel.appendLine(`[AgentRuntime] Failed to send queued prompt: ${error}`);
        });
    }

    private async runQueuedInteractivePrompt(terminal: vscode.Terminal, provider: AgentProviderConfig, prompt: string): Promise<void> {
        if (terminal === this.interactiveTerminal && this.interactiveTerminalStarted && this.interactiveTerminalProviderId === provider.id) {
            const submitDelay = this.sendPromptToInteractiveTerminal(terminal, provider, prompt);
            await this.wait(submitDelay);
            return;
        }

        await this.wait(this.configManager.getTerminalDelay());
        terminal.sendText(this.buildInteractiveCommand(provider), true);
        this.interactiveTerminal = terminal;
        this.interactiveTerminalProviderId = provider.id;
        this.interactiveTerminalStarted = true;
        await this.wait(TerminalAgentRuntime.INTERACTIVE_PROMPT_PASTE_DELAY);
        const submitDelay = this.sendPromptToInteractiveTerminal(terminal, provider, prompt);
        await this.wait(submitDelay);
    }

    private getOrCreateInteractiveTerminal(title: string | undefined, providerId: string): vscode.Terminal {
        if (this.interactiveTerminal && this.interactiveTerminalProviderId === providerId) {
            return this.interactiveTerminal;
        }

        const terminal = this.createTerminal(title);
        this.interactiveTerminal = terminal;
        this.interactiveTerminalProviderId = providerId;
        this.interactiveTerminalStarted = false;
        this.interactivePromptQueue = Promise.resolve();
        return terminal;
    }

    private getOrCreateCommandTerminal(title: string | undefined, providerId: string): vscode.Terminal {
        if (this.commandTerminal && this.commandTerminalProviderId === providerId) {
            return this.commandTerminal;
        }

        const terminal = this.createTerminal(title);
        this.commandTerminal = terminal;
        this.commandTerminalProviderId = providerId;
        return terminal;
    }

    private createTerminal(title?: string): vscode.Terminal {
        return vscode.window.createTerminal({
            name: title || `AutoCode - ${this.provider.displayName}`,
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            location: {
                viewColumn: vscode.ViewColumn.Two
            }
        });
    }

    private decoratePrompt(prompt: string, agentType?: AgentType): string {
        if (!agentType) {
            return prompt;
        }

        const agentConfig = getAgentConfig(agentType);
        const mcpServers = this.getAllowedMcpServers(agentConfig.mcpServers);
        const mcpLines = mcpServers.length > 0
            ? mcpServers.map(server => `- ${this.formatMcpServer(server)}`).join('\n')
            : '- None configured for this agent type';

        return `${prompt}

<agent_runtime_context>
Provider: ${this.provider.displayName}
Agent type: ${agentConfig.displayName}
Preferred model role: ${agentConfig.defaultModelRole}
Thinking level: ${agentConfig.thinkingDefault}
Allowed tool categories: ${agentConfig.tools.join(', ')}
MCP servers available to this workflow:
${mcpLines}

Use these tools and MCP servers when the active provider exposes equivalent capabilities. If a named tool is unavailable, use the provider's nearest file, search, shell, or web capability and continue with the same workflow.
</agent_runtime_context>`;
    }

    private getAllowedMcpServers(allowedNames: readonly string[]): McpServerInfo[] {
        if (allowedNames.length === 0) {
            return [];
        }

        const allowed = new Set(allowedNames);
        return getRuntimeMcpServers(this.provider)
            .filter(server => allowed.has(server.name) && server.status !== 'unsupported');
    }

    private formatMcpServer(server: McpServerInfo): string {
        const source = server.providerSource ? `, source: ${server.providerSource}` : '';
        const envKeys = server.env ? `, env keys: ${Object.keys(server.env).join(', ')}` : '';

        if (server.url) {
            return `${server.name} (${server.type}, ${server.url}${source}${envKeys})`;
        }

        const command = [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
        return `${server.name} (${server.type}${command ? `, command: ${command}` : ''}${source}${envKeys})`;
    }

    private async createTempFile(content: string, prefix: string = 'prompt'): Promise<string> {
        const tempDir = this.context.globalStorageUri.fsPath;
        await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);

        const tempFile = path.join(tempDir, `${prefix}-${Date.now()}.md`);
        await fs.promises.writeFile(tempFile, content);

        return this.convertPathIfWSL(tempFile);
    }

    private buildCommand(promptFilePath: string, provider: AgentProviderConfig = this.provider): string {
        const promptSubstitution = this.buildPromptSubstitution(promptFilePath);
        const args = (provider.args ?? []).map(arg => this.quoteShellArg(arg)).join(' ');
        const command = this.quoteCommand(provider.command);

        if (provider.id === 'claude') {
            return `${command} --permission-mode bypassPermissions "${promptSubstitution}"`;
        }

        if (provider.id === 'codex') {
            return `${this.buildPromptReadCommand(promptFilePath)} | ${command} exec ${args} -`.replace(/\s+/g, ' ').trim();
        }

        if (provider.commandTemplate) {
            const model = provider.model ? this.quoteShellArg(provider.model) : '';
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

    private buildInteractiveCommand(provider: AgentProviderConfig = this.provider): string {
        const args = (provider.args ?? []).map(arg => this.quoteShellArg(arg)).join(' ');

        if (provider.id === 'claude') {
            return `${this.quoteCommand(provider.command)} --permission-mode bypassPermissions`;
        }

        return [this.quoteCommand(provider.command), args].filter(Boolean).join(' ');
    }

    private sendPromptToInteractiveTerminal(terminal: vscode.Terminal, provider: AgentProviderConfig, prompt: string): number {
        const normalizedPrompt = prompt.replace(/\r\n/g, '\n');
        terminal.show();
        terminal.sendText(`\x1b[200~${normalizedPrompt}\x1b[201~`, false);

        const submitDelay = this.getInteractivePromptSubmitDelay(normalizedPrompt, provider);

        setTimeout(() => {
            this.submitInteractivePrompt(terminal, provider);
        }, submitDelay);

        return submitDelay;
    }

    private getInteractivePromptSubmitDelay(normalizedPrompt: string, provider: AgentProviderConfig): number {
        if (provider.id === 'codex') {
            return Math.min(
                TerminalAgentRuntime.CODEX_INTERACTIVE_PROMPT_SUBMIT_MAX_DELAY,
                Math.max(
                    TerminalAgentRuntime.CODEX_INTERACTIVE_PROMPT_SUBMIT_MIN_DELAY,
                    Math.ceil(normalizedPrompt.length / TerminalAgentRuntime.CODEX_INTERACTIVE_PROMPT_CHARS_PER_DELAY_MS)
                )
            );
        }

        return Math.min(
            TerminalAgentRuntime.INTERACTIVE_PROMPT_SUBMIT_MAX_DELAY,
            Math.max(
                TerminalAgentRuntime.INTERACTIVE_PROMPT_SUBMIT_MIN_DELAY,
                Math.ceil(normalizedPrompt.length / 200)
            )
        );
    }

    private wait(delayMs: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, delayMs));
    }

    private submitInteractivePrompt(terminal: vscode.Terminal, provider: AgentProviderConfig): void {
        terminal.show();

        if (provider.id === 'codex') {
            terminal.sendText('', true);
            return;
        }

        vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: '\r' }).then(
            undefined,
            () => terminal.sendText('', true)
        );
    }

    private buildPromptSubstitution(promptFilePath: string): string {
        if (process.platform === 'win32' && !this.shouldUseWslPaths()) {
            return `$(Get-Content -Raw -LiteralPath '${this.escapePowerShellSingleQuoted(promptFilePath)}')`;
        }

        return `$(cat "${this.escapeDoubleQuoted(promptFilePath)}")`;
    }

    private buildPromptReadCommand(promptFilePath: string): string {
        if (process.platform === 'win32' && !this.shouldUseWslPaths()) {
            return `Get-Content -Raw -LiteralPath '${this.escapePowerShellSingleQuoted(promptFilePath)}'`;
        }

        return `cat "${this.escapeDoubleQuoted(promptFilePath)}"`;
    }

    private quoteCommand(command: string): string {
        if (!command.trim()) {
            throw new Error(`No command configured for ${this.provider.displayName}`);
        }

        if (/^[A-Za-z0-9_.:/\\-]+$/.test(command)) {
            return command;
        }

        return this.quoteShellArg(command);
    }

    private quoteShellArg(value: string): string {
        if (/^[A-Za-z0-9_./:@=+\-]+$/.test(value)) {
            return value;
        }

        return `"${this.escapeDoubleQuoted(value)}"`;
    }

    private escapeDoubleQuoted(value: string): string {
        return value.replace(/(["`$\\])/g, '\\$1');
    }

    private escapePowerShellSingleQuoted(value: string): string {
        return value.replace(/'/g, "''");
    }

    private schedulePromptCleanup(promptFilePath: string, delayMs: number): void {
        setTimeout(async () => {
            await this.cleanupPromptFile(promptFilePath);
        }, delayMs);
    }

    private async cleanupPromptFile(promptFilePath: string): Promise<void> {
        try {
            await fs.promises.unlink(promptFilePath);
            this.outputChannel.appendLine(`[AgentRuntime] Cleaned up prompt file: ${promptFilePath}`);
        } catch (e) {
            this.outputChannel.appendLine(`[AgentRuntime] Failed to cleanup temp file: ${e}`);
        }
    }

    private convertPathIfWSL(filePath: string): string {
        if (process.platform === 'win32' && this.shouldUseWslPaths() && filePath.match(/^[A-Za-z]:\\/)) {
            let wslPath = filePath.replace(/\\/g, '/');
            wslPath = wslPath.replace(/^([A-Za-z]):/, (_match, drive) => `/mnt/${drive.toLowerCase()}`);
            return wslPath;
        }

        return filePath;
    }

    private shouldUseWslPaths(): boolean {
        if (/^wsl(?:\.exe)?$/i.test(path.basename(this.provider.command))) {
            return true;
        }

        const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
        const defaultProfile = terminalConfig.get<string>('defaultProfile.windows', '');
        if (/(wsl|ubuntu|debian)/i.test(defaultProfile)) {
            return true;
        }

        const profiles = terminalConfig.get<Record<string, { source?: string; path?: string }>>('profiles.windows', {});
        const profile = defaultProfile ? profiles?.[defaultProfile] : undefined;
        return !!profile && (
            /wsl/i.test(profile.source ?? '') ||
            /wsl(?:\.exe)?$/i.test(profile.path ?? '')
        );
    }

    static createPermissionTerminal(): vscode.Terminal {
        const provider = getProviderConfig('claude');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const terminal = vscode.window.createTerminal({
            name: 'Claude Code - Permission Setup',
            cwd: workspaceFolder,
            location: { viewColumn: vscode.ViewColumn.Two }
        });

        terminal.show();
        terminal.sendText(
            `${provider.command} --permission-mode bypassPermissions`,
            true
        );

        return terminal;
    }
}
