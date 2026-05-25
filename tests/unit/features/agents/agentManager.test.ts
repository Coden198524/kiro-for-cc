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
            readFile: jest.fn(),
            writeFile: jest.fn().mockResolvedValue(undefined)
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
        const targetPath = path.join(mockWorkspaceRoot, '.autocode', 'agents', 'autocode');
        const codexTargetPath = path.join(mockWorkspaceRoot, '.codex', 'agents');
        (fs.promises.readFile as jest.Mock).mockResolvedValue(`---
name: spec-requirements
description: Requirements agent
---

Use requirements instructions.`);
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('File not found'));

        await agentManager.initializeBuiltInAgents();

        expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: targetPath })
        );
        expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: codexTargetPath })
        );
        expect(vscode.workspace.fs.copy).not.toHaveBeenCalled();
        expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: path.join(targetPath, 'spec-requirements.md') }),
            expect.any(Buffer)
        );
        expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: path.join(codexTargetPath, 'spec-requirements.toml') }),
            expect.any(Buffer)
        );
        const codexAgentWrite = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls
            .find(([uri]) => uri.fsPath.endsWith('spec-requirements.toml'));
        expect(codexAgentWrite[1].toString()).toContain('developer_instructions = """');
        expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('[AgentManager] Copied agent')
        );
    });

    test('skips existing built-in agents', async () => {
        (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri) => {
            const normalizedPath = uri.fsPath.replace(/\\/g, '/');
            if (normalizedPath.includes('spec-requirements') || normalizedPath.includes('spec-design') || normalizedPath.endsWith('.codex/config.toml')) {
                return Promise.resolve({ type: vscode.FileType.File });
            }
            return Promise.reject(new Error('Not found'));
        });
        (fs.promises.readFile as jest.Mock).mockResolvedValue(`---
name: Test Agent
description: Test
---

Instructions`);

        await agentManager.initializeBuiltInAgents();

        expect(vscode.workspace.fs.copy).not.toHaveBeenCalled();
        expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(11);
        expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('already exists, skipping')
        );
    });

    test('falls back to source resources when dist system prompt resource is missing', async () => {
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('File not found'));
        (fs.promises.readFile as jest.Mock).mockImplementation(async (sourcePath: string) => {
            const normalizedPath = sourcePath.replace(/\\/g, '/');
            if (normalizedPath.includes('/dist/resources/prompts/')) {
                throw new Error('missing dist prompt');
            }

            if (normalizedPath.includes('/src/resources/prompts/spec-workflow-starter.md')) {
                return 'Spec workflow starter prompt';
            }

            return `---
name: spec-requirements
description: Requirements agent
---

Use requirements instructions.`;
        });

        await agentManager.initializeBuiltInAgents();

        const readPaths = (fs.promises.readFile as jest.Mock).mock.calls
            .map(([sourcePath]) => String(sourcePath).replace(/\\/g, '/'));
        expect(readPaths.some(sourcePath => sourcePath.includes('/src/resources/prompts/spec-workflow-starter.md'))).toBe(true);
        expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: path.join(mockWorkspaceRoot, '.autocode', 'system-prompts', 'spec-workflow-starter.md') }),
            expect.any(Buffer)
        );
    });

    test('ensures missing Codex agents and config are ready before launch', async () => {
        mockWorkspaceFileState();
        (fs.promises.readFile as jest.Mock).mockResolvedValue(`---
name: spec-requirements
description: Requirements agent
---

Use requirements instructions.`);

        const result = await agentManager.ensureCodexAgentsReady();

        expect(result.ready).toBe(true);
        expect(result.agentsPath?.replace(/\\/g, '/')).toBe('/test/workspace/.codex/agents');
        expect(result.configPath?.replace(/\\/g, '/')).toBe('/test/workspace/.codex/config.toml');
        expect(result.createdAgents).toContain('spec-requirements');
        expect(result.missingAgents).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: expect.stringContaining('spec-requirements.toml') }),
            expect.any(Buffer)
        );
        expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: expect.stringContaining('config.toml') }),
            expect.any(Buffer)
        );
    });

    test('falls back to source resources when dist agent resources are missing', async () => {
        mockWorkspaceFileState();
        (fs.promises.readFile as jest.Mock).mockImplementation(async (sourcePath: string) => {
            const normalizedPath = sourcePath.replace(/\\/g, '/');
            if (normalizedPath.includes('/dist/resources/agents/')) {
                throw new Error('missing dist resource');
            }

            return `---
name: spec-requirements
description: Requirements agent
---

Use requirements instructions.`;
        });

        const result = await agentManager.ensureCodexAgentsReady();

        const readPaths = (fs.promises.readFile as jest.Mock).mock.calls
            .map(([sourcePath]) => String(sourcePath).replace(/\\/g, '/'));
        expect(result.ready).toBe(true);
        expect(readPaths.some(sourcePath => sourcePath.includes('/src/resources/agents/spec-requirements.md'))).toBe(true);
    });

    test('reports Codex agents not ready when built-in sources are unavailable', async () => {
        mockWorkspaceFileState();
        (fs.promises.readFile as jest.Mock).mockRejectedValue(new Error('missing source'));

        const result = await agentManager.ensureCodexAgentsReady();

        expect(result.ready).toBe(false);
        expect(result.missingAgents).toEqual(expect.arrayContaining([
            'spec-requirements',
            'spec-design',
            'spec-tasks',
            'spec-system-prompt-loader',
            'spec-judge',
            'spec-impl',
            'spec-test'
        ]));
        expect(result.errors.join('\n')).toContain('built-in agent source for spec-requirements not found');
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

        const agents = await agentManager.getAgentList('project', 'claude');

        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({
            name: 'Test Agent',
            description: 'A test agent',
            tools: ['Read', 'Write'],
            type: 'project'
        });
    });

    test('includes built-in project agents from the autocode directory', async () => {
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
                    ['autocode', vscode.FileType.Directory]
                ]);
            }

            if (normalizedPath.endsWith('.autocode/agents/autocode')) {
                return Promise.resolve([
                    ['spec-requirements.md', vscode.FileType.File]
                ]);
            }

            return Promise.resolve([]);
        });
        (fs.promises.readFile as jest.Mock).mockResolvedValue(mockAgentContent);

        const agents = await agentManager.getAgentList('project', 'claude');

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

        const agents = await agentManager.getAgentList('user', 'claude');

        expect(agents[0]).toMatchObject({
            name: 'User Agent',
            tools: ['Read', 'Write', 'Task'],
            type: 'user'
        });
    });

    test('returns project Codex agents parsed from TOML', async () => {
        const mockAgentContent = [
            'name = "spec-requirements"',
            'description = "Requirements expert"',
            'developer_instructions = """Use requirements instructions."""'
        ].join('\n');
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['spec-requirements.toml', vscode.FileType.File]
        ]);
        (fs.promises.readFile as jest.Mock).mockResolvedValue(mockAgentContent);

        const agents = await agentManager.getAgentList('project', 'codex');

        expect((vscode.workspace.fs.readDirectory as jest.Mock).mock.calls[0][0].fsPath.replace(/\\/g, '/'))
            .toBe('/test/workspace/.codex/agents');
        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({
            name: 'spec-requirements',
            description: 'Requirements expert',
            type: 'project',
            provider: 'codex'
        });
    });

    test('returns user Codex agents from the Codex user agents directory', async () => {
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['reviewer.toml', vscode.FileType.File]
        ]);
        (fs.promises.readFile as jest.Mock).mockResolvedValue('name = "reviewer"\ndescription = "Review expert"');

        const agents = await agentManager.getAgentList('user', 'codex');

        expect(vscode.workspace.fs.readDirectory).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: path.join('/home/test', '.codex', 'agents') })
        );
        expect(agents[0]).toMatchObject({
            name: 'reviewer',
            description: 'Review expert',
            type: 'user',
            provider: 'codex'
        });
    });

    test('resolves project agent path under .autocode before user agents', () => {
        (fs.existsSync as jest.Mock).mockImplementation((candidatePath: string) => (
            candidatePath.includes('.autocode/agents/autocode/test-agent.md')
        ));

        expect(agentManager.getAgentPath('test-agent')).toBe(`${mockWorkspaceRoot}/.autocode/agents/autocode/test-agent.md`);
    });

    test('returns null for a missing agent path', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(false);

        expect(agentManager.getAgentPath('missing-agent')).toBeNull();
    });

    test('checks whether a project agent exists', () => {
        (fs.existsSync as jest.Mock).mockImplementation((candidatePath: string) => (
            candidatePath.includes('autocode/existing-agent.md')
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

    function mockWorkspaceFileState(existingPaths: string[] = []): Set<string> {
        const files = new Set(existingPaths.map(normalizePath));

        (vscode.workspace.fs.stat as jest.Mock).mockImplementation(async (uri) => {
            if (files.has(normalizePath(uri.fsPath))) {
                return { type: vscode.FileType.File };
            }

            throw new Error('File not found');
        });
        (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(async (uri) => {
            files.add(normalizePath(uri.fsPath));
        });
        (vscode.workspace.fs.createDirectory as jest.Mock).mockImplementation(async (uri) => {
            files.add(normalizePath(uri.fsPath));
        });

        return files;
    }

    function normalizePath(filePath: string): string {
        return filePath.replace(/\\/g, '/');
    }
});
