import * as vscode from 'vscode';
import * as fs from 'fs';
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
        readFile: jest.fn(),
        readdir: jest.fn(),
        stat: jest.fn(),
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
        (fs.promises.readdir as jest.Mock).mockRejectedValue(new Error('missing directory'));
        (fs.promises.stat as jest.Mock).mockRejectedValue(new Error('missing file'));
        (fs.promises.unlink as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.Uri as any).file = (filePath: string) => ({
            fsPath: filePath,
            path: filePath,
            scheme: 'file'
        });
        (vscode.workspace as any).workspaceFolders = [{
            uri: vscode.Uri.file('/mock/workspace'),
            name: 'mock-workspace',
            index: 0
        }];
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
        delete (vscode.window as any).onDidChangeTerminalShellIntegration;
        delete (vscode.window as any).onDidStartTerminalShellExecution;
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

    test('builds Codex CLI command with approval policy before exec', () => {
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            args: ['--model', 'gpt-5.5'],
            capabilities: cliCapabilities()
        });

        const command = (runtime as any).buildCommand('/tmp/autocode-storage/prompt-12345.md', undefined, {
            approvalPolicy: 'never'
        });

        expect(command).toBe(`${expectedPromptRead('/tmp/autocode-storage/prompt-12345.md')} | codex --ask-for-approval never --sandbox danger-full-access exec --model gpt-5.5 -`);
    });

    test('uses configured Codex automation sandbox bypass before exec', () => {
        configValues['providers.codex.autoTaskSandboxMode'] = 'bypass';
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            args: ['--model', 'gpt-5.5'],
            capabilities: cliCapabilities()
        });

        const command = (runtime as any).buildCommand('/tmp/autocode-storage/prompt-12345.md', undefined, {
            approvalPolicy: 'never'
        });

        expect(command).toBe(`${expectedPromptRead('/tmp/autocode-storage/prompt-12345.md')} | codex --dangerously-bypass-approvals-and-sandbox exec --model gpt-5.5 -`);
    });

    test('runs visible headless requests in a terminal and captures output for parsing', async () => {
        configValues['agent.provider'] = 'codex';
        configValues['providers.codex.command'] = 'codex';
        configValues['providers.codex.args'] = ['--model', 'gpt-5.5'];
        const terminal = {
            name: 'Verification Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };
        (vscode.window.createTerminal as jest.Mock).mockReturnValue(terminal);
        (fs.promises.readFile as jest.Mock)
            .mockResolvedValueOnce('0')
            .mockResolvedValueOnce('{"completed":true,"confidence":0.92}');

        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            args: ['--model', 'gpt-5.5'],
            capabilities: cliCapabilities()
        });

        const result = await runtime.invokeHeadless({
            prompt: 'verify task',
            title: 'AutoCode - Verify Task Completion',
            approvalPolicy: 'never',
            visibleTerminal: true
        });

        expect(vscode.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
            name: 'AutoCode - Verify Task Completion'
        }));
        expect(terminal.show).toHaveBeenCalled();
        expect(terminal.sendText).toHaveBeenCalledTimes(1);
        const sentCommand = (terminal.sendText as jest.Mock).mock.calls[0][0] as string;
        expect(sentCommand).toContain(process.platform === 'win32' ? 'Get-Content -Raw -LiteralPath' : 'cat ');
        expect(sentCommand).toContain('visible-background-prompt-');
        expect(sentCommand).toContain('codex --ask-for-approval never --sandbox danger-full-access exec --model gpt-5.5 -');
        expect(sentCommand).toContain(process.platform === 'win32' ? 'Tee-Object' : 'tee');
        expect(result).toEqual({
            exitCode: 0,
            output: '{"completed":true,"confidence":0.92}'
        });
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

    test('builds Codex interactive launch command with approval policy', () => {
        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            args: ['--model', 'gpt-5.5'],
            capabilities: cliCapabilities()
        });

        expect((runtime as any).buildInteractiveCommand(undefined, 'never')).toBe('codex --ask-for-approval never --sandbox danger-full-access --model gpt-5.5');
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

    test('sends a prompt-file instruction into Claude interactive terminal', async () => {
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
        const sentPrompt = terminal.sendText.mock.calls[1][0] as string;
        expect(sentPrompt).toContain('\x1b[200~AutoCode has written the full prompt to a local file');
        expect(sentPrompt).toContain('interactive-prompt-');
        expect(sentPrompt).not.toContain('Feature Description: 支持中文 Spec');
        expect(fs.promises.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('.autocode'),
            'Feature Description: 支持中文 Spec'
        );
        expect(fs.promises.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('runtime-prompts'),
            expect.any(String)
        );
    });

    test('pastes and submits prompt-file instruction into Codex interactive terminal after Codex delay', async () => {
        jest.useFakeTimers();
        configValues['agent.provider'] = 'codex';
        configValues['providers.codex.command'] = 'codex';
        const terminal = {
            name: 'Mock Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };
        (vscode.window.createTerminal as jest.Mock).mockReturnValue(terminal);

        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });

        await runtime.invokeInteractive({
            prompt: 'Feature Description: 支持中文 Spec',
            title: 'AutoCode - Creating Spec'
        });

        jest.advanceTimersByTime(800);
        expect(terminal.sendText).toHaveBeenNthCalledWith(1, 'codex', true);

        jest.advanceTimersByTime(1500);
        const sentPrompt = terminal.sendText.mock.calls[1][0] as string;
        expect(sentPrompt).toContain('\x1b[200~AutoCode has written the full prompt to a local file');
        expect(sentPrompt).toContain('interactive-prompt-');
        expect(sentPrompt).not.toContain('Feature Description: 支持中文 Spec');
        expect(fs.promises.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('.autocode'),
            'Feature Description: 支持中文 Spec'
        );
        expect(fs.promises.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('runtime-prompts'),
            expect.any(String)
        );

        jest.advanceTimersByTime(1199);
        expect(terminal.sendText).toHaveBeenCalledTimes(2);

        jest.advanceTimersByTime(1);
        expect(terminal.sendText).toHaveBeenNthCalledWith(3, '', true);
    });

    test('waits for observable shell readiness before launching an interactive Codex command', async () => {
        jest.useFakeTimers();
        configValues['agent.provider'] = 'codex';
        configValues['providers.codex.command'] = 'codex';
        let shellReadyHandler: ((event: { terminal: vscode.Terminal }) => void) | undefined;
        let shellStartHandler: ((event: { terminal: vscode.Terminal }) => void) | undefined;
        (vscode.window as any).onDidChangeTerminalShellIntegration = jest.fn(handler => {
            shellReadyHandler = handler;
            return { dispose: jest.fn() };
        });
        (vscode.window as any).onDidStartTerminalShellExecution = jest.fn(handler => {
            shellStartHandler = handler;
            return { dispose: jest.fn() };
        });
        const terminal = {
            name: 'Mock Terminal',
            sendText: jest.fn(),
            show: jest.fn(),
            shellIntegration: undefined
        };
        (vscode.window.createTerminal as jest.Mock).mockReturnValue(terminal);

        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });

        await runtime.invokeInteractive({
            prompt: 'Feature Description: observable readiness',
            title: 'AutoCode - Creating Spec'
        });

        await jest.advanceTimersByTimeAsync(800);
        expect(terminal.sendText).not.toHaveBeenCalledWith('codex', true);

        shellReadyHandler?.({ terminal: terminal as any });
        await flushPromises();
        expect(terminal.sendText).toHaveBeenNthCalledWith(1, 'codex', true);

        shellStartHandler?.({ terminal: terminal as any });
        await jest.advanceTimersByTimeAsync(1500);
        expect(terminal.sendText.mock.calls[1][0]).toContain('interactive-prompt-');
    });

    test('starts auto Codex interactive terminal with approval disabled', async () => {
        jest.useFakeTimers();
        configValues['agent.provider'] = 'codex';
        configValues['providers.codex.command'] = 'codex';
        const terminal = {
            name: 'Mock Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };
        (vscode.window.createTerminal as jest.Mock).mockReturnValue(terminal);

        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });

        await runtime.invokeInteractive({
            prompt: 'Auto task',
            title: 'AutoCode - Task 1',
            reuseTerminal: true,
            approvalPolicy: 'never'
        });

        await jest.advanceTimersByTimeAsync(800);
        expect(terminal.sendText).toHaveBeenNthCalledWith(1, 'codex --ask-for-approval never --sandbox danger-full-access', true);
    });

    test('sends interactive requests to a provided target terminal without opening a new terminal', async () => {
        jest.useFakeTimers();
        configValues['agent.provider'] = 'codex';
        configValues['providers.codex.command'] = 'codex';
        const taskTerminal = {
            name: 'Task Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };

        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });

        const returnedTerminal = await runtime.invokeInteractive({
            prompt: 'Verify in this terminal',
            title: 'AutoCode - Verify Task Completion',
            approvalPolicy: 'never',
            targetTerminal: taskTerminal as any
        });

        expect(returnedTerminal).toBe(taskTerminal);
        expect(vscode.window.createTerminal).not.toHaveBeenCalled();
        expect(taskTerminal.show).toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(800);
        const sentPrompt = taskTerminal.sendText.mock.calls[0][0] as string;
        expect(sentPrompt).toContain('\x1b[200~AutoCode has written the full prompt to a local file');
        expect(sentPrompt).toContain('interactive-prompt-');
        expect(sentPrompt).not.toContain('Verify in this terminal');

        await jest.advanceTimersByTimeAsync(1200);
        expect(taskTerminal.sendText).toHaveBeenNthCalledWith(2, '', true);
    });

    test('does not reuse a normal Codex terminal for approval-disabled automation', async () => {
        jest.useFakeTimers();
        configValues['agent.provider'] = 'codex';
        configValues['providers.codex.command'] = 'codex';
        const normalTerminal = {
            name: 'Normal Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };
        const autoTerminal = {
            name: 'Auto Terminal',
            sendText: jest.fn(),
            show: jest.fn()
        };
        (vscode.window.createTerminal as jest.Mock)
            .mockReturnValueOnce(normalTerminal)
            .mockReturnValueOnce(autoTerminal);

        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });

        await runtime.invokeInteractive({
            prompt: 'Manual task',
            title: 'AutoCode - Manual Task',
            reuseTerminal: true
        });
        await jest.advanceTimersByTimeAsync(2300);

        await runtime.invokeInteractive({
            prompt: 'Auto task',
            title: 'AutoCode - Task 1',
            reuseTerminal: true,
            approvalPolicy: 'never'
        });
        await jest.advanceTimersByTimeAsync(800);

        expect(vscode.window.createTerminal).toHaveBeenCalledTimes(2);
        expect(normalTerminal.sendText).toHaveBeenNthCalledWith(1, 'codex', true);
        expect(autoTerminal.sendText).toHaveBeenNthCalledWith(1, 'codex --ask-for-approval never --sandbox danger-full-access', true);
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
        expect(terminal.sendText.mock.calls[1][0]).toContain('\x1b[200~AutoCode has written the full prompt to a local file');
        expect(terminal.sendText.mock.calls[1][0]).not.toContain('First task');
        expect(terminal.sendText.mock.calls[2][0]).toContain('\x1b[200~AutoCode has written the full prompt to a local file');
        expect(terminal.sendText.mock.calls[2][0]).not.toContain('Second task');
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
        expect(terminal.sendText.mock.calls[1][0]).toContain('\x1b[200~AutoCode has written the full prompt to a local file');
        expect(terminal.sendText.mock.calls[1][0]).not.toContain('First task');
        expect(terminal.sendText.mock.calls[2][0]).toContain('\x1b[200~AutoCode has written the full prompt to a local file');
        expect(terminal.sendText.mock.calls[2][0]).not.toContain('Second task');
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

    test('delays and submits Codex interactive prompt with terminal newline', () => {
        jest.useFakeTimers();
        const provider: AgentProviderConfig = {
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        };
        const runtime = createRuntime(provider);
        const terminal = {
            sendText: jest.fn(),
            show: jest.fn()
        };

        const submitDelay = (runtime as any).sendPromptToInteractiveTerminal(terminal, provider, 'line 1\r\nline 2');
        jest.advanceTimersByTime(1199);

        expect(terminal.sendText).toHaveBeenNthCalledWith(1, '\x1b[200~line 1\nline 2\x1b[201~', false);
        expect(submitDelay).toBe(1200);
        expect(terminal.sendText).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1);

        expect(terminal.sendText).toHaveBeenNthCalledWith(2, '', true);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('uses configured Codex interactive submit delay bounds', () => {
        configValues['providers.codex.interactiveSubmitDelayMinMs'] = 500;
        configValues['providers.codex.interactiveSubmitDelayMaxMs'] = 2000;
        configValues['providers.codex.interactiveSubmitDelayCharsPerMs'] = 10;
        const provider: AgentProviderConfig = {
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        };
        const runtime = createRuntime(provider);

        expect((runtime as any).getInteractivePromptSubmitDelay('short prompt', provider)).toBe(500);
        expect((runtime as any).getInteractivePromptSubmitDelay('x'.repeat(30000), provider)).toBe(2000);
    });

    test('falls back to terminal newline if sendSequence fails for non-Codex prompts', async () => {
        jest.useFakeTimers();
        (vscode.commands.executeCommand as jest.Mock).mockRejectedValue(new Error('send failed'));
        const provider = {
            id: 'claude',
            displayName: 'Claude Code',
            command: 'claude',
            capabilities: claudeCapabilities()
        } as AgentProviderConfig;
        const runtime = createRuntime(provider);
        const terminal = {
            sendText: jest.fn(),
            show: jest.fn()
        };

        (runtime as any).sendPromptToInteractiveTerminal(terminal, provider, 'line 1');
        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.terminal.sendSequence', { text: '\r' });
        expect(terminal.sendText).toHaveBeenNthCalledWith(2, '', true);
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

    test('cleans up expired runtime prompt files on startup', async () => {
        configValues['promptFileRetentionDays'] = 1;
        const oldPrompt = '/mock/workspace/.autocode/runtime-prompts/interactive-prompt-old.md';
        const freshPrompt = '/mock/workspace/.autocode/runtime-prompts/interactive-prompt-fresh.md';
        (fs.promises.readdir as jest.Mock).mockImplementation(async (directoryPath: string) => {
            if (directoryPath.replace(/\\/g, '/') === '/mock/workspace/.autocode/runtime-prompts') {
                return ['interactive-prompt-old.md', 'interactive-prompt-fresh.md', 'notes.txt'];
            }

            throw new Error(`unexpected directory ${directoryPath}`);
        });
        (fs.promises.stat as jest.Mock).mockImplementation(async (filePath: string) => ({
            mtimeMs: filePath.replace(/\\/g, '/') === oldPrompt
                ? Date.now() - 2 * 24 * 60 * 60 * 1000
                : Date.now()
        }));

        const runtime = createRuntime({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            capabilities: cliCapabilities()
        });
        await (runtime as any).cleanupExpiredPromptFiles();

        const deletedPaths = (fs.promises.unlink as jest.Mock).mock.calls
            .map(call => String(call[0]).replace(/\\/g, '/'));
        expect(deletedPaths).toContain(oldPrompt);
        expect(deletedPaths).not.toContain(freshPrompt);
    });

    function createRuntime(provider: AgentProviderConfig): TerminalAgentRuntime {
        return new TerminalAgentRuntime(context, outputChannel, provider);
    }

    async function flushPromises(): Promise<void> {
        for (let index = 0; index < 8; index++) {
            await Promise.resolve();
        }
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
