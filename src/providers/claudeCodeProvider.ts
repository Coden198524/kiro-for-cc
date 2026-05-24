import * as vscode from 'vscode';
import { TerminalAgentRuntime } from '../runtime/terminalAgentRuntime';
import { getProviderConfig } from '../runtime/providerRegistry';

/**
 * Backward-compatible Claude provider wrapper.
 *
 * New code should depend on AgentRuntime directly. This class is kept so
 * existing permission tests and Claude-only integration points continue to
 * work while the extension moves toward provider-neutral agent execution.
 */
export class ClaudeCodeProvider extends TerminalAgentRuntime {
    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        super(context, outputChannel, getProviderConfig('claude'));
    }

    async invokeClaudeSplitView(prompt: string, title: string = 'Kiro for Agent Code'): Promise<vscode.Terminal> {
        return this.invokeInteractive({ prompt, title });
    }

    async invokeClaudeHeadless(prompt: string): Promise<{ exitCode: number | undefined; output?: string }> {
        return this.invokeHeadless({ prompt, mode: 'headless' });
    }

    static createPermissionTerminal(): vscode.Terminal {
        return TerminalAgentRuntime.createPermissionTerminal();
    }
}
