import * as vscode from 'vscode';
import { TerminalAgentRuntime } from '../../../src/runtime/terminalAgentRuntime';
import { AgentProviderConfig } from '../../../src/runtime/agentRuntime';
import { ConfigManager } from '../../../src/utils/configManager';

jest.mock('vscode');

jest.mock('../../../src/extension', () => ({
    getPermissionManager: jest.fn(() => undefined)
}));

jest.mock('fs', () => ({
    promises: {
        writeFile: jest.fn(),
        unlink: jest.fn()
    }
}));

describe('TerminalAgentRuntime', () => {
    let context: vscode.ExtensionContext;
    let outputChannel: vscode.OutputChannel;
    let configValues: Record<string, unknown>;

    beforeEach(() => {
        jest.clearAllMocks();
        configValues = {};
        (ConfigManager as any).instance = undefined;
        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace as any).getConfiguration = jest.fn(() => ({
            inspect: jest.fn((key: string) => (
                Object.prototype.hasOwnProperty.call(configValues, key)
                    ? { workspaceValue: configValues[key] }
                    : undefined
            )),
            get: jest.fn((key: string, defaultValue?: unknown) => (
                Object.prototype.hasOwnProperty.call(configValues, key)
                    ? configValues[key]
                    : defaultValue
            ))
        }));
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

        context = {
            globalStorageUri: { fsPath: '/tmp/autocode-storage' },
            subscriptions: []
        } as any;
        outputChannel = {
            appendLine: jest.fn()
        } as any;
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('builds Claude permission bypass command', () => {
        const runtime = createRuntime({
            id: 'claude',
            displayName: 'Claude Code',
            command: 'claude',
            capabilities: claudeCapabilities()
        });

        const command = (runtime as any).buildCommand('/tmp/autocode-storage/prompt-12345.md');

        expect(command).toBe(`claude --permission-mode bypassPermissions ${expectedPromptArg('/tmp/autocode-storage/prompt-12345.md')}`);
    });

    test('builds CLI command with configured args', () => {
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            args: ['--model', 'gpt-5.5'],
            capabilities: cliCapabilities()
        });

        const command = (runtime as any).buildCommand('/tmp/autocode-storage/prompt-12345.md');

        expect(command).toBe(`${expectedPromptRead('/tmp/autocode-storage/prompt-12345.md')} | codex exec --model gpt-5.5 -`);
    });

    test('builds custom provider command template', () => {
        const runtime = createRuntime({
            id: 'custom',
            displayName: 'Local Agent',
            command: 'local-agent',
            model: 'local model',
            args: ['run'],
            commandTemplate: '{command} {args} --model {model} --input "{prompt}"',
            capabilities: cliCapabilities()
        });

        const command = (runtime as any).buildCommand('/tmp/autocode-storage/prompt-12345.md');

        expect(command).toBe(`local-agent run --model "local model" --input ${expectedPromptArg('/tmp/autocode-storage/prompt-12345.md')}`);
    });

    test('quotes commands and args containing spaces', () => {
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: '/opt/Agent CLI/codex',
            args: ['--profile', 'team default'],
            capabilities: cliCapabilities()
        });

        const command = (runtime as any).buildCommand('/tmp/autocode-storage/prompt-12345.md');

        expect(command).toBe(`${expectedPromptRead('/tmp/autocode-storage/prompt-12345.md')} | "/opt/Agent CLI/codex" exec --profile "team default" -`);
    });

    test('adds agent capability and MCP context to prompts', () => {
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });

        const prompt = (runtime as any).decoratePrompt('base prompt', 'task_implementer');

        expect(prompt).toContain('base prompt');
        expect(prompt).toContain('<agent_runtime_context>');
        expect(prompt).toContain('Provider: Codex');
        expect(prompt).toContain('Agent type: Task Implementer');
        expect(prompt).toContain('Allowed tool categories: Read, Glob, Grep, Write, Edit, Bash');
        expect(prompt).toContain('context7');
    });

    test('builds Codex interactive launch command without exec', () => {
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            args: ['--model', 'gpt-5.5'],
            capabilities: cliCapabilities()
        });

        expect((runtime as any).buildInteractiveCommand()).toBe('codex --model gpt-5.5');
    });

    test('builds Claude interactive launch command with permission bypass', () => {
        const runtime = createRuntime({
            id: 'claude',
            displayName: 'Claude Code',
            command: 'claude',
            capabilities: claudeCapabilities()
        });

        expect((runtime as any).buildInteractiveCommand()).toBe('claude --permission-mode bypassPermissions');
    });

    test('pastes prompt into Claude interactive terminal', async () => {
        jest.useFakeTimers();
        const terminal = {
            name: 'Mock Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };
        (vscode.window.createTerminal as jest.Mock).mockReturnValue(terminal);

        const runtime = createRuntime({
            id: 'claude',
            displayName: 'Claude Code',
            command: 'claude',
            capabilities: claudeCapabilities()
        });

        await runtime.invokeInteractive({
            prompt: 'Feature Description: 支持中文 Spec',
            title: 'AutoCode - Creating Spec'
        });

        jest.advanceTimersByTime(800);
        expect(terminal.sendText).toHaveBeenNthCalledWith(1, 'claude --permission-mode bypassPermissions', true);

        jest.advanceTimersByTime(1500);
        expect(terminal.sendText).toHaveBeenNthCalledWith(2, '\x1b[200~Feature Description: 支持中文 Spec\x1b[201~', false);
    });

    test('reuses interactive terminal when requested', async () => {
        jest.useFakeTimers();
        const terminal = {
            name: 'Mock Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };
        (vscode.window.createTerminal as jest.Mock).mockReturnValue(terminal);

        const runtime = createRuntime({
            id: 'claude',
            displayName: 'Claude Code',
            command: 'claude',
            capabilities: claudeCapabilities()
        });

        await runtime.invokeInteractive({
            prompt: 'First task',
            title: 'AutoCode - Implementing Task',
            reuseTerminal: true
        });
        await jest.advanceTimersByTimeAsync(2300);

        await runtime.invokeInteractive({
            prompt: 'Second task',
            title: 'AutoCode - Implementing Task',
            reuseTerminal: true
        });
        await jest.advanceTimersByTimeAsync(800);

        expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1);
        expect(terminal.sendText).toHaveBeenNthCalledWith(1, 'claude --permission-mode bypassPermissions', true);
        expect(terminal.sendText).toHaveBeenNthCalledWith(2, '\x1b[200~First task\x1b[201~', false);
        expect(terminal.sendText).toHaveBeenNthCalledWith(3, '\x1b[200~Second task\x1b[201~', false);
    });

    test('reuses allocated interactive terminal before launch delay completes', async () => {
        jest.useFakeTimers();
        const terminal = {
            name: 'Mock Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };
        (vscode.window.createTerminal as jest.Mock).mockReturnValue(terminal);

        const runtime = createRuntime({
            id: 'claude',
            displayName: 'Claude Code',
            command: 'claude',
            capabilities: claudeCapabilities()
        });

        await runtime.invokeInteractive({
            prompt: 'First task',
            title: 'AutoCode - Implementing Task',
            reuseTerminal: true
        });
        await runtime.invokeInteractive({
            prompt: 'Second task',
            title: 'AutoCode - Implementing Task',
            reuseTerminal: true
        });

        await jest.advanceTimersByTimeAsync(2800);

        expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1);
        expect(terminal.sendText).toHaveBeenNthCalledWith(1, 'claude --permission-mode bypassPermissions', true);
        expect(terminal.sendText).toHaveBeenNthCalledWith(2, '\x1b[200~First task\x1b[201~', false);
        expect(terminal.sendText).toHaveBeenNthCalledWith(3, '\x1b[200~Second task\x1b[201~', false);
    });

    test('reuses command terminal for non-interactive CLI providers when requested', async () => {
        jest.useFakeTimers();
        configValues['agent.provider'] = 'deepseek';
        configValues['providers.deepseek.command'] = 'deepseek-chat';
        configValues['providers.deepseek.args'] = ['--model', 'deepseek-reasoner'];

        const terminal = {
            name: 'Mock Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };
        (vscode.window.createTerminal as jest.Mock).mockReturnValue(terminal);

        const runtime = createRuntime({
            id: 'deepseek',
            displayName: 'DeepSeek',
            command: 'deepseek-chat',
            args: ['--model', 'deepseek-reasoner'],
            capabilities: cliCapabilities()
        });

        await runtime.invokeInteractive({
            prompt: 'First task',
            title: 'AutoCode - Implementing Task',
            reuseTerminal: true
        });
        await runtime.invokeInteractive({
            prompt: 'Second task',
            title: 'AutoCode - Implementing Task',
            reuseTerminal: true
        });

        jest.advanceTimersByTime(800);

        expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1);
        expect(terminal.sendText).toHaveBeenCalledTimes(2);
        expect(terminal.sendText.mock.calls[0][0]).toContain('deepseek-chat --model deepseek-reasoner');
        expect(terminal.sendText.mock.calls[1][0]).toContain('deepseek-chat --model deepseek-reasoner');
    });

    test('submits interactive prompt with an explicit carriage return', () => {
        jest.useFakeTimers();
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });
        const terminal = {
            sendText: jest.fn(),
            show: jest.fn()
        };

        (runtime as any).sendPromptToInteractiveTerminal(terminal, 'line 1\r\nline 2');
        jest.advanceTimersByTime(500);

        expect(terminal.sendText).toHaveBeenNthCalledWith(1, '\x1b[200~line 1\nline 2\x1b[201~', false);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.terminal.sendSequence', { text: '\r' });
    });

    test('falls back to terminal sendText if sendSequence fails', async () => {
        jest.useFakeTimers();
        (vscode.commands.executeCommand as jest.Mock).mockRejectedValue(new Error('send failed'));
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });
        const terminal = {
            sendText: jest.fn(),
            show: jest.fn()
        };

        (runtime as any).sendPromptToInteractiveTerminal(terminal, 'line 1');
        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(terminal.sendText).toHaveBeenNthCalledWith(2, '\r', false);
    });

    test('keeps Windows prompt paths for non-WSL providers', () => {
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });

        const promptPath = 'C:\\Users\\LS\\AppData\\Roaming\\Code\\User\\globalStorage\\prompt.md';

        expect((runtime as any).convertPathIfWSL(promptPath)).toBe(promptPath);
    });

    test('converts Windows prompt paths only for WSL providers', () => {
        const runtime = createRuntime({
            id: 'custom',
            displayName: 'WSL Codex',
            command: 'wsl.exe',
            args: ['codex'],
            capabilities: cliCapabilities()
        });

        const promptPath = 'C:\\Users\\LS\\AppData\\Roaming\\Code\\User\\globalStorage\\prompt.md';
        const expected = process.platform === 'win32'
            ? '/mnt/c/Users/LS/AppData/Roaming/Code/User/globalStorage/prompt.md'
            : promptPath;

        expect((runtime as any).convertPathIfWSL(promptPath)).toBe(expected);
    });

    function createRuntime(provider: AgentProviderConfig): TerminalAgentRuntime {
        return new TerminalAgentRuntime(context, outputChannel, provider);
    }

    function expectedPromptArg(promptFilePath: string): string {
        if (process.platform === 'win32') {
            return `"$(Get-Content -Raw -LiteralPath '${promptFilePath.replace(/'/g, "''")}')"`;
        }

        return `"$(cat "${promptFilePath}")"`;
    }

    function expectedPromptRead(promptFilePath: string): string {
        if (process.platform === 'win32') {
            return `Get-Content -Raw -LiteralPath '${promptFilePath.replace(/'/g, "''")}'`;
        }

        return `cat "${promptFilePath}"`;
    }

    function claudeCapabilities() {
        return {
            permissions: true,
            expertAgents: true,
            claudeAgents: true,
            claudeHooks: true,
            claudeMcp: true,
            extensionMcp: true,
            headless: true,
            interactiveSpecWorkflow: true
        };
    }

    function cliCapabilities() {
        return {
            permissions: false,
            expertAgents: false,
            claudeAgents: false,
            claudeHooks: false,
            claudeMcp: false,
            extensionMcp: true,
            headless: true,
            interactiveSpecWorkflow: true
        };
    }
});
