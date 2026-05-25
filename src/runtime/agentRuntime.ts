import * as vscode from 'vscode';
import { AgentType } from './agentConfigs';

export type AgentProviderId = 'claude' | 'codex' | 'deepseek' | 'glm' | 'custom';

export type AgentRuntimeMode = 'interactive' | 'headless';

export type AgentApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

export interface AgentProviderCapabilities {
    permissions: boolean;
    expertAgents: boolean;
    claudeAgents: boolean;
    claudeHooks: boolean;
    claudeMcp: boolean;
    extensionMcp: boolean;
    headless: boolean;
    interactiveSpecWorkflow: boolean;
}

export interface AgentProviderConfig {
    id: AgentProviderId;
    displayName: string;
    command: string;
    model?: string;
    args?: string[];
    commandTemplate?: string;
    capabilities: AgentProviderCapabilities;
}

export interface AgentInvocationRequest {
    prompt: string;
    title?: string;
    mode?: AgentRuntimeMode;
    agentType?: AgentType;
    reuseTerminal?: boolean;
    approvalPolicy?: AgentApprovalPolicy;
}

export interface AgentInvocationResult {
    exitCode: number | undefined;
    output?: string;
    stderr?: string;
}

export interface AgentRuntime {
    readonly provider: AgentProviderConfig;
    refreshProvider?(): Promise<void>;
    invokeInteractive(request: AgentInvocationRequest): Promise<vscode.Terminal>;
    invokeHeadless(request: AgentInvocationRequest): Promise<AgentInvocationResult>;
    renameTerminal(terminal: vscode.Terminal, newName: string): Promise<void>;
}
