import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager } from '../../../../src/features/agents/agentManager';

jest.mock('vscode');
jest.mock('fs', () => ({
    promises: {
        readFile: jest.fn()
    },
    existsSync: jest.fn()
}));
jest.mock('os');

describe('AgentManager', () => {
    let agentManager: AgentManager;
    let mockContext: vscode.ExtensionContext;
    let mockOutputChannel: vscode.OutputChannel;
    const mockWorkspaceRoot = '/test/workspace';

    beforeEach(() => {
        jest.clearAllMocks();

        mockOutputChannel = {
            appendLine: jest.fn(),
            append: jest.fn(),
            show: jest.fn(),
            hide: jest.fn(),
            clear: jest.fn(),
            dispose: jest.fn(),
            replace: jest.fn()
        } as any;

        mockContext = {
            extensionPath: '/test/extension',
            subscriptions: []
        } as any;

        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: mockWorkspaceRoot }
        }];
        (vscode.workspace as any).fs = {
            createDirectory: jest.fn().mockResolvedValue(undefined),
            stat: jest.fn(),
            copy: jest.fn().mockResolvedValue(undefined),
            readDirectory: jest.fn(),
            readFile: jest.fn()
        };
        (vscode.Uri as any).file = jest.fn((filePath: string) => ({ fsPath: filePath }));
        (os.homedir as jest.Mock).mockReturnValue('/home/test');
        (vscode.FileType as any) = {
            File: 1,
            Directory: 2
        };

        agentManager = new AgentManager(mockContext, mockOutputChannel);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('initializes built-in project agents under .autocode', async () => {
        const targetPath = path.join(mockWorkspaceRoot, '.autocode', 'agents', 'kfc');
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('File not found'));

        await agentManager.initializeBuiltInAgents();

        expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: targetPath })
        );
        expect(vscode.workspace.fs.copy).toHaveBeenCalledTimes(8);
        expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('[AgentManager] Copied agent')
        );
    });

    test('skips existing built-in agents', async () => {
        (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri) => {
            if (uri.fsPath.includes('spec-requirements') || uri.fsPath.includes('spec-design')) {
                return Promise.resolve({ type: vscode.FileType.File });
            }
            return Promise.reject(new Error('Not found'));
        });

        await agentManager.initializeBuiltInAgents();

        expect(vscode.workspace.fs.copy).toHaveBeenCalledTimes(6);
        expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('already exists, skipping')
        );
    });

    test('returns project agents parsed from frontmatter', async () => {
        const mockAgentContent = `---
name: Test Agent
description: A test agent
tools: ["Read", "Write"]
---

Agent content here`;
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['test-agent.md', vscode.FileType.File]
        ]);
        (fs.promises.readFile as jest.Mock).mockResolvedValue(mockAgentContent);

        const agents = await agentManager.getAgentList('project');

        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({
            name: 'Test Agent',
            description: 'A test agent',
            tools: ['Read', 'Write'],
            type: 'project'
        });
    });

    test('includes built-in project agents from the kfc directory', async () => {
        const mockAgentContent = `---\r
name: spec-requirements\r
description: Built-in requirements agent\r
---\r
\r
Agent content here`;

        (vscode.workspace.fs.readDirectory as jest.Mock).mockImplementation((uri) => {
            const normalizedPath = uri.fsPath.replace(/\\/g, '/');

            if (normalizedPath.endsWith('.autocode/agents')) {
                return Promise.resolve([
                    ['kfc', vscode.FileType.Directory]
                ]);
            }

            if (normalizedPath.endsWith('.autocode/agents/kfc')) {
                return Promise.resolve([
                    ['spec-requirements.md', vscode.FileType.File]
                ]);
            }

            return Promise.resolve([]);
        });
        (fs.promises.readFile as jest.Mock).mockResolvedValue(mockAgentContent);

        const agents = await agentManager.getAgentList('project');

        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({
            name: 'spec-requirements',
            description: 'Built-in requirements agent',
            type: 'project'
        });
    });

    test('returns user agents from the Claude user agents directory', async () => {
        const mockAgentContent = `---
name: User Agent
description: A user agent
tools: Read, Write, Task
---`;
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['user-agent.md', vscode.FileType.File]
        ]);
        (fs.promises.readFile as jest.Mock).mockResolvedValue(mockAgentContent);

        const agents = await agentManager.getAgentList('user');

        expect(agents[0]).toMatchObject({
            name: 'User Agent',
            tools: ['Read', 'Write', 'Task'],
            type: 'user'
        });
    });

    test('resolves project agent path under .autocode before user agents', () => {
        (fs.existsSync as jest.Mock).mockImplementation((candidatePath: string) => (
            candidatePath.includes('.autocode/agents/kfc/test-agent.md')
        ));

        expect(agentManager.getAgentPath('test-agent')).toBe(`${mockWorkspaceRoot}/.autocode/agents/kfc/test-agent.md`);
    });

    test('returns null for a missing agent path', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(false);

        expect(agentManager.getAgentPath('missing-agent')).toBeNull();
    });

    test('checks whether a project agent exists', () => {
        (fs.existsSync as jest.Mock).mockImplementation((candidatePath: string) => (
            candidatePath.includes('kfc/existing-agent.md')
        ));

        expect(agentManager.checkAgentExists('existing-agent', 'project')).toBe(true);
        expect(agentManager.checkAgentExists('missing-agent', 'project')).toBe(false);
    });

    test('returns no project agents without a workspace', async () => {
        (vscode.workspace as any).workspaceFolders = undefined;
        const noWorkspaceManager = new AgentManager(mockContext, mockOutputChannel);

        await noWorkspaceManager.initializeBuiltInAgents();
        const projectAgents = await noWorkspaceManager.getAgentList('project');

        expect(projectAgents).toEqual([]);
        expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('No workspace'));
    });
});
