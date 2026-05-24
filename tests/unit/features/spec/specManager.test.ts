import * as vscode from 'vscode';
import { SpecManager } from '../../../../src/features/spec/specManager';
import { AgentRuntime, AgentProviderConfig } from '../../../../src/runtime/agentRuntime';
import { ConfigManager } from '../../../../src/utils/configManager';
import { PromptLoader } from '../../../../src/services/promptLoader';

jest.mock('vscode');

describe('SpecManager', () => {
    const provider: AgentProviderConfig = {
        id: 'claude',
        displayName: 'Claude Code',
        command: 'claude',
        capabilities: {
            permissions: true,
            claudeAgents: true,
            claudeHooks: true,
            claudeMcp: true,
            extensionMcp: true,
            headless: true,
            interactiveSpecWorkflow: true
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (ConfigManager as any).instance = undefined;
        PromptLoader.getInstance().initialize();
        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: '/mock/workspace', path: '/mock/workspace', scheme: 'file' },
            name: 'mock-workspace',
            index: 0
        }];
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            const normalizedPath = uri.fsPath.replace(/\\/g, '/');
            if (normalizedPath.endsWith('/.autocode/settings/autocode-settings.json') ||
                normalizedPath.endsWith('/.claude/settings/kfc-settings.json')) {
                throw new Error('missing settings');
            }

            if (normalizedPath.endsWith('/tasks.md')) {
                return Buffer.from('# 实现计划\n\n- [ ] 1. 实现中文任务\n  - 读取中文需求并保持中文输出');
            }

            if (normalizedPath.endsWith('/requirements.md')) {
                return Buffer.from('# 需求文档\n\n## 介绍\n\n这个功能需要支持中文任务实现流程。');
            }

            if (normalizedPath.endsWith('/design.md')) {
                return Buffer.from('# 设计文档\n\n系统应沿用中文上下文。');
            }

            throw new Error(`Unexpected read: ${uri.fsPath}`);
        });
    });

    test('uses the spec document language for task implementation prompts', async () => {
        let capturedPrompt = '';
        const runtime: AgentRuntime = {
            provider,
            refreshProvider: jest.fn(),
            invokeInteractive: jest.fn(async (request) => {
                capturedPrompt = request.prompt;
                return vscode.window.createTerminal('mock');
            }),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };

        const outputChannel = vscode.window.createOutputChannel('test');
        const specManager = new SpecManager(runtime, outputChannel);

        await specManager.implTask('/mock/workspace/.autocode/specs/demo/tasks.md', '1. 实现中文任务');

        expect(capturedPrompt).toContain('Language Preference: Chinese (中文)');
        expect(capturedPrompt).toContain('Use Chinese (中文) for all conversational responses');
        expect(capturedPrompt).toContain('从当前 spec 上下文开始执行这个任务');
    });
});
