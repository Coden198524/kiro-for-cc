import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as yaml from 'js-yaml';

export interface AgentInfo {
    name: string;
    description: string;
    path: string;
    type: AgentLocation;
    tools?: string[];
    provider?: 'autocode' | 'codex' | 'claude';
}

export type AgentLocation = 'project' | 'user';
export type AgentTargetProvider = 'claude' | 'codex' | 'all';

export class AgentManager {
    private outputChannel: vscode.OutputChannel;
    private extensionPath: string;
    private workspaceRoot: string | undefined;
    private static readonly PROJECT_DATA_DIR = '.autocode';
    private static readonly CODEX_DATA_DIR = '.codex';
    
    private readonly BUILT_IN_AGENTS = [
        'spec-requirements',
        'spec-design',
        'spec-tasks',
        'spec-system-prompt-loader',
        'spec-judge',
        'spec-impl',
        'spec-test'
    ];

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel
    ) {
        this.outputChannel = outputChannel;
        this.extensionPath = context.extensionPath;
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private joinWorkspacePath(...segments: string[]): string {
        if (!this.workspaceRoot) {
            return path.join(...segments);
        }

        return this.joinPathPreservingSeparator(this.workspaceRoot, ...segments);
    }

    private joinPathPreservingSeparator(basePath: string, ...segments: string[]): string {
        if (basePath.includes('/') && !basePath.includes('\\')) {
            return [basePath.replace(/\/+$/, ''), ...segments.map(segment => segment.replace(/^[/\\]+|[/\\]+$/g, ''))].join('/');
        }

        return path.join(basePath, ...segments);
    }

    /**
     * Initialize built-in agents (copy if not exist on startup)
     */
    async initializeBuiltInAgents(): Promise<void> {
        if (!this.workspaceRoot) {
            this.outputChannel.appendLine('[AgentManager] No workspace root found, skipping agent initialization');
            return;
        }

        const targetDir = path.join(this.workspaceRoot, AgentManager.PROJECT_DATA_DIR, 'agents', 'autocode');
        const codexTargetDir = path.join(this.workspaceRoot, AgentManager.CODEX_DATA_DIR, 'agents');
        
        try {
            // Ensure target directory exists
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(codexTargetDir));
            
            for (const agentName of this.BUILT_IN_AGENTS) {
                const sourcePath = path.join(this.extensionPath, 'dist/resources/agents', `${agentName}.md`);
                const targetPath = path.join(targetDir, `${agentName}.md`);
                
                try {
                    const sourceUri = vscode.Uri.file(sourcePath);
                    const targetUri = vscode.Uri.file(targetPath);
                    try {
                        await vscode.workspace.fs.stat(targetUri);
                        this.outputChannel.appendLine(`[AgentManager] Agent ${agentName} already exists, skipping`);
                    } catch {
                        await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: false });
                        this.outputChannel.appendLine(`[AgentManager] Copied agent ${agentName}`);
                    }
                } catch (error) {
                    this.outputChannel.appendLine(`[AgentManager] Failed to copy agent ${agentName}: ${error}`);
                }

                await this.initializeCodexAgent(agentName, sourcePath, codexTargetDir);
            }
            
            await this.initializeCodexConfig();

            // Also copy system prompt if it doesn't exist
            await this.initializeSystemPrompt();
            
        } catch (error) {
            this.outputChannel.appendLine(`[AgentManager] Failed to initialize agents: ${error}`);
        }
    }

    /**
     * Initialize system prompt (copy if not exist)
     */
    private async initializeSystemPrompt(): Promise<void> {
        if (!this.workspaceRoot) {
            return;
        }

        const systemPromptDir = path.join(this.workspaceRoot, AgentManager.PROJECT_DATA_DIR, 'system-prompts');
        const sourcePath = path.join(this.extensionPath, 'dist/resources/prompts', 'spec-workflow-starter.md');
        const targetPath = path.join(systemPromptDir, 'spec-workflow-starter.md');

        try {
            // Ensure directory exists
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(systemPromptDir));
            
            await vscode.workspace.fs.copy(vscode.Uri.file(sourcePath), vscode.Uri.file(targetPath), { overwrite: false });
            this.outputChannel.appendLine('[AgentManager] Copied system prompt');
        } catch (error) {
            this.outputChannel.appendLine(`[AgentManager] Failed to initialize system prompt: ${error}`);
        }
    }

    /**
     * Get list of agents
     */
    async getAgentList(type: 'project' | 'user' | 'all' = 'all', targetProvider: AgentTargetProvider = 'all'): Promise<AgentInfo[]> {
        const agents: AgentInfo[] = [];

        if (type === 'project' || type === 'all') {
            if (this.workspaceRoot) {
                const projectAgentDirs = this.getProjectAgentDirs(targetProvider);
                for (const projectAgentsPath of projectAgentDirs) {
                    const projectAgents = await this.getAgentsFromDirectory(
                        projectAgentsPath,
                        'project'
                    );
                    agents.push(...projectAgents);
                }
            }
        }

        if (type === 'user' || type === 'all') {
            const userAgentDirs = this.getUserAgentDirs(targetProvider);
            for (const userAgentsPath of userAgentDirs) {
                const userAgents = await this.getAgentsFromDirectory(userAgentsPath, 'user');
                agents.push(...userAgents);
            }
        }

        return agents;
    }

    getCodexProjectAgentsPath(): string | undefined {
        return this.workspaceRoot
            ? this.joinWorkspacePath(AgentManager.CODEX_DATA_DIR, 'agents')
            : undefined;
    }

    getCodexProjectConfigPath(): string | undefined {
        return this.workspaceRoot
            ? this.joinWorkspacePath(AgentManager.CODEX_DATA_DIR, 'config.toml')
            : undefined;
    }

    /**
     * Get agents from a specific directory (including subdirectories)
     */
    private async getAgentsFromDirectory(dirPath: string, type: AgentLocation): Promise<AgentInfo[]> {
        const agents: AgentInfo[] = [];

        try {
            this.outputChannel.appendLine(`[AgentManager] Reading agents from directory: ${dirPath}`);
            await this.readAgentsRecursively(dirPath, type, agents);
            this.outputChannel.appendLine(`[AgentManager] Total agents found in ${dirPath}: ${agents.length}`);
        } catch (error) {
            this.outputChannel.appendLine(`[AgentManager] Failed to read agents from ${dirPath}: ${error}`);
        }

        return agents;
    }

    /**
     * Recursively read agents from directory and subdirectories
     */
    private async readAgentsRecursively(dirPath: string, type: AgentLocation, agents: AgentInfo[]): Promise<void> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
            
            for (const [fileName, fileType] of entries) {
                const fullPath = path.join(dirPath, fileName);

                if (fileType === vscode.FileType.File && this.isAgentFile(fileName)) {
                    this.outputChannel.appendLine(`[AgentManager] Processing agent file: ${fileName}`);
                    const agentInfo = await this.parseAgentFile(fullPath, type);
                    if (agentInfo) {
                        agents.push(agentInfo);
                        this.outputChannel.appendLine(`[AgentManager] Added agent: ${agentInfo.name}`);
                    } else {
                        this.outputChannel.appendLine(`[AgentManager] Failed to parse agent: ${fileName}`);
                    }
                } else if (fileType === vscode.FileType.Directory) {
                    // Recursively read subdirectories
                    this.outputChannel.appendLine(`[AgentManager] Entering subdirectory: ${fileName}`);
                    await this.readAgentsRecursively(fullPath, type, agents);
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`[AgentManager] Error reading directory ${dirPath}: ${error}`);
        }
    }

    /**
     * Parse agent file and extract metadata
     */
    private async parseAgentFile(filePath: string, type: AgentLocation): Promise<AgentInfo | null> {
        try {
            this.outputChannel.appendLine(`[AgentManager] Parsing agent file: ${filePath}`);
            const content = await fs.promises.readFile(filePath, 'utf8');
            if (this.normalizePathForMatch(filePath).endsWith('.toml')) {
                return this.parseCodexAgentFile(filePath, type, content);
            }
            
            // Extract YAML frontmatter
            const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!frontmatterMatch) {
                this.outputChannel.appendLine(`[AgentManager] No frontmatter found in: ${filePath}`);
                return null;
            }

            let frontmatter: any;
            try {
                // Debug: log the frontmatter content for spec-system-prompt-loader
                if (path.basename(filePath) === 'spec-system-prompt-loader.md') {
                    this.outputChannel.appendLine(`[AgentManager] Frontmatter content for spec-system-prompt-loader:`);
                    this.outputChannel.appendLine(frontmatterMatch[1]);
                }
                
                frontmatter = yaml.load(frontmatterMatch[1]) as any;
                this.outputChannel.appendLine(`[AgentManager] Successfully parsed YAML for: ${path.basename(filePath)}`);
            } catch (yamlError) {
                this.outputChannel.appendLine(`[AgentManager] YAML parse error in ${path.basename(filePath)}: ${yamlError}`);
                if (path.basename(filePath) === 'spec-system-prompt-loader.md') {
                    this.outputChannel.appendLine(`[AgentManager] Raw frontmatter that failed:`);
                    this.outputChannel.appendLine(frontmatterMatch[1]);
                }
                return null;
            }
            
            return {
                name: frontmatter.name || path.basename(filePath, '.md'),
                description: frontmatter.description || '',
                path: filePath,
                type,
                provider: this.normalizePathForMatch(filePath).includes('/.claude/agents/') ? 'claude' : 'autocode',
                tools: Array.isArray(frontmatter.tools) 
                    ? frontmatter.tools 
                    : (frontmatter.tools ? frontmatter.tools.split(',').map((t: string) => t.trim()) : undefined)
            };
        } catch (error) {
            this.outputChannel.appendLine(`[AgentManager] Failed to parse agent file ${filePath}: ${error}`);
            return null;
        }
    }

    /**
     * Check if agent exists
     */
    checkAgentExists(agentName: string, location: 'project' | 'user'): boolean {
        const basePath = location === 'project' 
            ? (this.workspaceRoot ? this.joinWorkspacePath(AgentManager.PROJECT_DATA_DIR, 'agents', 'autocode') : null)
            : path.join(os.homedir(), '.claude/agents');

        if (!basePath) {
            return false;
        }

        const agentPath = this.joinPathPreservingSeparator(basePath, `${agentName}.md`);
        return fs.existsSync(agentPath);
    }

    /**
     * Get agent file path
     */
    getAgentPath(agentName: string): string | null {
        // Check project agents first
        if (this.workspaceRoot) {
            const projectPath = this.joinWorkspacePath(AgentManager.PROJECT_DATA_DIR, 'agents', 'autocode', `${agentName}.md`);
            if (fs.existsSync(projectPath)) {
                return projectPath;
            }
        }

        // Check user agents
        const userPath = this.joinPathPreservingSeparator(path.join(os.homedir(), '.claude/agents'), `${agentName}.md`);
        if (fs.existsSync(userPath)) {
            return userPath;
        }

        return null;
    }

    private getProjectAgentDirs(targetProvider: AgentTargetProvider): string[] {
        if (!this.workspaceRoot) {
            return [];
        }

        if (targetProvider === 'codex') {
            return [this.joinWorkspacePath(AgentManager.CODEX_DATA_DIR, 'agents')];
        }

        if (targetProvider === 'claude') {
            return [this.joinWorkspacePath(AgentManager.PROJECT_DATA_DIR, 'agents')];
        }

        return [
            this.joinWorkspacePath(AgentManager.PROJECT_DATA_DIR, 'agents'),
            this.joinWorkspacePath(AgentManager.CODEX_DATA_DIR, 'agents')
        ];
    }

    private getUserAgentDirs(targetProvider: AgentTargetProvider): string[] {
        if (targetProvider === 'codex') {
            return [path.join(os.homedir(), '.codex', 'agents')];
        }

        if (targetProvider === 'claude') {
            return [path.join(os.homedir(), '.claude', 'agents')];
        }

        return [
            path.join(os.homedir(), '.claude', 'agents'),
            path.join(os.homedir(), '.codex', 'agents')
        ];
    }

    private isAgentFile(fileName: string): boolean {
        return fileName.endsWith('.md') || fileName.endsWith('.toml');
    }

    private normalizePathForMatch(filePath: string): string {
        return filePath.replace(/\\/g, '/');
    }

    private async initializeCodexAgent(agentName: string, sourcePath: string, codexTargetDir: string): Promise<void> {
        const targetPath = path.join(codexTargetDir, `${agentName}.toml`);

        try {
            const targetUri = vscode.Uri.file(targetPath);
            try {
                await vscode.workspace.fs.stat(targetUri);
                this.outputChannel.appendLine(`[AgentManager] Codex agent ${agentName} already exists, skipping`);
                return;
            } catch {
                // File does not exist, create it below.
            }

            const source = await fs.promises.readFile(sourcePath, 'utf8');
            const codexAgent = this.convertMarkdownAgentToCodexToml(agentName, source);
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(codexAgent));
            this.outputChannel.appendLine(`[AgentManager] Created Codex agent ${agentName}`);
        } catch (error) {
            this.outputChannel.appendLine(`[AgentManager] Failed to create Codex agent ${agentName}: ${error}`);
        }
    }

    private async initializeCodexConfig(): Promise<void> {
        if (!this.workspaceRoot) {
            return;
        }

        const configPath = path.join(this.workspaceRoot, AgentManager.CODEX_DATA_DIR, 'config.toml');
        const configUri = vscode.Uri.file(configPath);

        try {
            await vscode.workspace.fs.stat(configUri);
            return;
        } catch {
            // File does not exist, create it below.
        }

        const content = [
            '# AutoCode project-level Codex configuration.',
            '# Built-in expert agents are generated under .codex/agents/.',
            ''
        ].join('\n');
        await vscode.workspace.fs.writeFile(configUri, Buffer.from(content));
        this.outputChannel.appendLine('[AgentManager] Created Codex config');
    }

    private convertMarkdownAgentToCodexToml(agentName: string, source: string): string {
        const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        const body = frontmatterMatch
            ? source.slice(frontmatterMatch[0].length).trim()
            : source.trim();
        const frontmatter = frontmatterMatch ? yaml.load(frontmatterMatch[1]) as any : {};
        const name = this.tomlEscape(String(frontmatter?.name || agentName));
        const description = this.tomlEscape(String(frontmatter?.description || 'AutoCode expert agent'));
        const instructions = this.tomlMultilineString([
            body,
            '',
            'Use the current workspace as the project root.',
            'Follow AutoCode spec workflow paths under .autocode/specs unless the user provides another path.'
        ].join('\n'));

        return [
            `name = "${name}"`,
            `description = "${description}"`,
            'model = "inherit"',
            `developer_instructions = ${instructions}`,
            ''
        ].join('\n');
    }

    private parseCodexAgentFile(filePath: string, type: AgentLocation, content: string): AgentInfo {
        const name = this.readTomlString(content, 'name') || path.basename(filePath, '.toml');
        const description = this.readTomlString(content, 'description') || '';

        return {
            name,
            description,
            path: filePath,
            type,
            provider: 'codex'
        };
    }

    private readTomlString(content: string, key: string): string | undefined {
        const match = content.match(new RegExp(`^${key}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, 'm'));
        return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : undefined;
    }

    private tomlEscape(value: string): string {
        return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
    }

    private tomlMultilineString(value: string): string {
        return `"""${value.replace(/"""/g, '\\"\\"\\"')}"""`;
    }
}
