import {
    buildAgentCommand,
    buildAgentInteractiveCommand,
    buildPromptReadCommand,
    buildPromptSubstitution,
    convertPathForWsl,
    quoteCommand
} from '../../../src/runtime/agentCommandBuilder';
import { AgentProviderCapabilities, AgentProviderConfig } from '../../../src/runtime/agentRuntime';

describe('agentCommandBuilder', () => {
    test('builds Codex headless command with PowerShell prompt piping on Windows', () => {
        const provider = createProvider({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            args: ['--model', 'gpt-5.5']
        });

        const command = buildAgentCommand({
            provider,
            promptFilePath: 'C:\\Users\\LS\\prompt.md',
            platform: 'win32',
            useWslPaths: false
        });

        expect(command).toBe("Get-Content -Raw -LiteralPath 'C:\\Users\\LS\\prompt.md' | codex exec --model gpt-5.5 -");
    });

    test('builds Codex commands with invocation approval policy before the subcommand', () => {
        const provider = createProvider({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            args: ['--ask-for-approval', 'on-request', '--model', 'gpt-5.5']
        });

        const headlessCommand = buildAgentCommand({
            provider,
            promptFilePath: 'C:\\Users\\LS\\prompt.md',
            platform: 'win32',
            useWslPaths: false,
            approvalPolicy: 'never'
        });
        const interactiveCommand = buildAgentInteractiveCommand(provider, {
            approvalPolicy: 'never'
        });

        expect(headlessCommand).toBe("Get-Content -Raw -LiteralPath 'C:\\Users\\LS\\prompt.md' | codex --ask-for-approval never exec --model gpt-5.5 -");
        expect(interactiveCommand).toBe('codex --ask-for-approval never --model gpt-5.5');
    });

    test('builds Claude permission command with POSIX prompt substitution', () => {
        const provider = createProvider({
            id: 'claude',
            displayName: 'Claude Code',
            command: 'claude'
        });

        const command = buildAgentCommand({
            provider,
            promptFilePath: '/tmp/autocode prompt.md',
            platform: 'linux',
            useWslPaths: false
        });

        expect(command).toBe('claude --permission-mode bypassPermissions "$(cat "/tmp/autocode prompt.md")"');
    });

    test('builds custom template with quoted command, args, and model', () => {
        const provider = createProvider({
            id: 'custom',
            displayName: 'Local Agent',
            command: '/opt/Agent CLI/agent',
            args: ['run', '--profile', 'team default'],
            model: 'local model',
            commandTemplate: '{command} {args} --model {model} --input "{prompt}"'
        });

        const command = buildAgentCommand({
            provider,
            promptFilePath: '/tmp/prompt.md',
            platform: 'linux',
            useWslPaths: false
        });

        expect(command).toBe('"/opt/Agent CLI/agent" run --profile "team default" --model "local model" --input "$(cat "/tmp/prompt.md")"');
    });

    test('builds interactive command separately from headless execution wrappers', () => {
        expect(buildAgentInteractiveCommand(createProvider({
            id: 'codex',
            displayName: 'Codex',
            command: 'codex',
            args: ['--model', 'gpt-5.5']
        }))).toBe('codex --model gpt-5.5');

        expect(buildAgentInteractiveCommand(createProvider({
            id: 'claude',
            displayName: 'Claude Code',
            command: 'claude'
        }))).toBe('claude --permission-mode bypassPermissions');
    });

    test('escapes prompt paths for PowerShell and POSIX shells', () => {
        expect(buildPromptReadCommand("C:\\Users\\LS\\prompt's.md", {
            platform: 'win32',
            useWslPaths: false
        })).toBe("Get-Content -Raw -LiteralPath 'C:\\Users\\LS\\prompt''s.md'");

        expect(buildPromptSubstitution('/tmp/prompt `"$.md', {
            platform: 'linux',
            useWslPaths: false
        })).toBe('$(cat "/tmp/prompt \\`\\"\\$.md")');
    });

    test('converts Windows paths for WSL providers only', () => {
        const promptPath = 'C:\\Users\\LS\\AppData\\Roaming\\Code\\User\\globalStorage\\prompt.md';

        expect(convertPathForWsl(promptPath, {
            platform: 'win32',
            useWslPaths: true
        })).toBe('/mnt/c/Users/LS/AppData/Roaming/Code/User/globalStorage/prompt.md');

        expect(convertPathForWsl(promptPath, {
            platform: 'win32',
            useWslPaths: false
        })).toBe(promptPath);
    });

    test('rejects empty provider commands', () => {
        expect(() => quoteCommand('   ', 'Codex')).toThrow('No command configured for Codex');
    });

    function createProvider(overrides: Partial<AgentProviderConfig>): AgentProviderConfig {
        return {
            id: 'custom',
            displayName: 'Test Agent',
            command: 'agent',
            capabilities: cliCapabilities(),
            ...overrides
        };
    }

    function cliCapabilities(): AgentProviderCapabilities {
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
