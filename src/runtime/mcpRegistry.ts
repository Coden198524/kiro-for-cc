import { AgentProviderConfig } from './agentRuntime';
import { getRuntimeCustomMcpServers } from './runtimeSettings';

export type McpTransportType = 'stdio' | 'sse' | 'http';
export type McpServerScope = 'extension' | 'local' | 'project' | 'user';
export type McpServerStatus = 'available' | 'connected' | 'disconnected' | 'unsupported' | 'unknown';

export interface McpServerInfo {
    name: string;
    type: McpTransportType;
    scope: McpServerScope;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    status: McpServerStatus;
    description?: string;
    providerSource?: string;
    removeCommand?: string;
}

interface CustomMcpServerSetting {
    id?: string;
    name?: string;
    type?: McpTransportType | 'command';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    description?: string;
}

const BUILT_IN_SERVERS: McpServerInfo[] = [
    {
        name: 'context7',
        type: 'stdio',
        scope: 'extension',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@latest'],
        status: 'available',
        description: 'Documentation lookup for libraries and frameworks',
        providerSource: 'Kiro'
    },
    {
        name: 'puppeteer',
        type: 'stdio',
        scope: 'extension',
        command: 'npx',
        args: ['-y', '@anthropic-ai/puppeteer-mcp-server'],
        status: 'available',
        description: 'Browser automation for frontend validation',
        providerSource: 'Kiro'
    },
    {
        name: 'electron',
        type: 'stdio',
        scope: 'extension',
        command: 'npx',
        args: ['-y', 'electron-mcp-server'],
        status: 'available',
        description: 'Electron app automation via Chrome DevTools Protocol',
        providerSource: 'Kiro'
    }
];

export function getBuiltInMcpServers(): McpServerInfo[] {
    return BUILT_IN_SERVERS.map(server => ({ ...server, args: server.args ? [...server.args] : undefined }));
}

export function getCustomMcpServers(): McpServerInfo[] {
    const servers = getRuntimeCustomMcpServers() as CustomMcpServerSetting[];

    if (!Array.isArray(servers)) {
        return [];
    }

    return servers
        .map(toMcpServerInfo)
        .filter((server): server is McpServerInfo => !!server);
}

export function getRuntimeMcpServers(provider: AgentProviderConfig): McpServerInfo[] {
    const servers = [...getBuiltInMcpServers(), ...getCustomMcpServers()];

    if (!provider.capabilities.extensionMcp) {
        return servers.map(server => ({
            ...server,
            status: 'unsupported',
            description: `${server.description || server.name} (not supported by ${provider.displayName})`
        }));
    }

    return servers;
}

function toMcpServerInfo(setting: CustomMcpServerSetting): McpServerInfo | null {
    const name = (setting.name || setting.id || '').trim();
    if (!name) {
        return null;
    }

    if (setting.type === 'http' || setting.type === 'sse') {
        if (!setting.url) {
            return null;
        }

        return {
            name,
            type: setting.type,
            scope: 'extension',
            url: setting.url,
            headers: setting.headers,
            status: 'available',
            description: setting.description,
            providerSource: 'Custom'
        };
    }

    if (!setting.command) {
        return null;
    }

    return {
        name,
        type: 'stdio',
        scope: 'extension',
        command: setting.command,
        args: Array.isArray(setting.args) ? setting.args : [],
        env: setting.env,
        status: 'available',
        description: setting.description,
        providerSource: 'Custom'
    };
}
