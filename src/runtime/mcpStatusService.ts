import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AgentProviderConfig } from './agentRuntime';
import { getRuntimeMcpServers, McpServerInfo } from './mcpRegistry';

const execAsync = promisify(exec);

export class McpStatusService {
    constructor(
        private outputChannel: vscode.OutputChannel,
        private provider: AgentProviderConfig
    ) {}

    async listServers(): Promise<McpServerInfo[]> {
        const extensionServers = getRuntimeMcpServers(this.provider);

        if (!this.provider.capabilities.claudeMcp) {
            return extensionServers;
        }

        const claudeServers = await this.listClaudeServers();
        return [...extensionServers, ...claudeServers];
    }

    private async listClaudeServers(): Promise<McpServerInfo[]> {
        const servers = new Map<string, McpServerInfo>();

        try {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const command = this.quoteCommand(this.provider.command);
            const { stdout, stderr } = await execAsync(`${command} mcp list`, { cwd });

            if (stderr) {
                this.outputChannel.appendLine(`${this.provider.command} mcp list stderr: ${stderr}`);
                if (!stdout) {
                    return [];
                }
            }

            for (const server of this.parseClaudeListOutput(stdout)) {
                servers.set(server.name, server);
            }

            await Promise.all(Array.from(servers.keys()).map(async (name) => {
                const details = await this.loadClaudeServerDetails(name);
                const existing = servers.get(name);
                if (existing && details) {
                    servers.set(name, { ...existing, ...details });
                }
            }));
        } catch (error) {
            this.outputChannel.appendLine(`Failed to load Claude MCP servers: ${error}`);
        }

        return Array.from(servers.values());
    }

    private parseClaudeListOutput(output: string): McpServerInfo[] {
        const servers: McpServerInfo[] = [];
        const lines = output.split('\n').filter(line => line.trim());

        for (const line of lines) {
            const colonIndex = line.indexOf(':');
            if (colonIndex <= 0) {
                continue;
            }

            const name = line.substring(0, colonIndex).trim();
            const status = line.toLowerCase().includes('connected')
                ? 'connected'
                : line.toLowerCase().includes('failed')
                    ? 'disconnected'
                    : 'unknown';

            servers.push({
                name,
                type: 'stdio',
                scope: 'local',
                status,
                providerSource: 'Claude Code'
            });
        }

        return servers;
    }

    private async loadClaudeServerDetails(name: string): Promise<Partial<McpServerInfo> | null> {
        try {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const command = this.quoteCommand(this.provider.command);
            const { stdout, stderr } = await execAsync(`${command} mcp get ${this.quoteForShell(name)}`, { cwd });

            if (stderr) {
                this.outputChannel.appendLine(`Error getting details for ${name}: ${stderr}`);
            }

            return this.parseClaudeServerDetails(stdout);
        } catch (error) {
            this.outputChannel.appendLine(`Failed to get details for ${name}: ${error}`);
            return null;
        }
    }

    private parseClaudeServerDetails(output: string): Partial<McpServerInfo> {
        const details: Partial<McpServerInfo> = {};
        const lines = output.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith('Scope:')) {
                const scopeMatch = trimmed.match(/Scope:\s*(\w+)/);
                const scope = scopeMatch?.[1]?.toLowerCase();
                if (scope === 'user' || scope === 'project' || scope === 'local') {
                    details.scope = scope;
                }
            } else if (trimmed.startsWith('Type:')) {
                const type = trimmed.substring(5).trim().toLowerCase();
                if (type === 'stdio' || type === 'sse' || type === 'http') {
                    details.type = type;
                }
            } else if (trimmed.startsWith('Command:')) {
                details.command = trimmed.substring(8).trim();
            } else if (trimmed.startsWith('Args:')) {
                const argsStr = trimmed.substring(5).trim();
                details.args = argsStr ? argsStr.split(/\s+/) : [];
            } else if (trimmed.startsWith('URL:')) {
                details.url = trimmed.substring(4).trim();
            } else if (trimmed.startsWith('Headers:')) {
                const headerStr = trimmed.substring(8).trim();
                if (headerStr) {
                    details.headers = this.parseKeyValueList(headerStr);
                }
            } else if (trimmed.startsWith('Environment:') || trimmed.startsWith('Env:')) {
                const envStr = trimmed.substring(trimmed.indexOf(':') + 1).trim();
                if (envStr && envStr !== '(none)' && envStr !== 'None') {
                    details.env = this.parseKeyValueList(envStr);
                }
            } else if (trimmed.startsWith('To remove this server')) {
                const match = trimmed.match(/\bmcp remove "(.+?)" -s (.+)$/);
                if (match) {
                    details.removeCommand = `${this.provider.command} mcp remove "${match[1]}" -s ${match[2]}`;
                }
            }
        }

        return details;
    }

    private parseKeyValueList(input: string): Record<string, string> {
        const result: Record<string, string> = {};
        const pairs = input.includes(',') ? input.split(',') : input.split(/\s+/);

        for (const pair of pairs) {
            const separatorIndex = pair.includes('=') ? pair.indexOf('=') : pair.indexOf(':');
            if (separatorIndex <= 0) {
                continue;
            }

            const key = pair.substring(0, separatorIndex).trim();
            const value = pair.substring(separatorIndex + 1).trim();
            if (key) {
                result[key] = value;
            }
        }

        return result;
    }

    private quoteForShell(value: string): string {
        return `"${value.replace(/(["`$\\])/g, '\\$1')}"`;
    }

    private quoteCommand(command: string): string {
        if (/^[A-Za-z0-9_.:/\\-]+$/.test(command)) {
            return command;
        }

        return this.quoteForShell(command);
    }
}
