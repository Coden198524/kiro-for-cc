import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as yaml from 'js-yaml';

export interface AgentInfo {
    name: string;
    description: string;
    path: string;
    type: 'project' | 'user';
    tools?: string[];
}

export class AgentManager {
    private outputChannel: vscode.OutputChannel;
    private extensionPath: string;
    private workspaceRoot: string | undefined;
    private static readonly PROJECT_DATA_DIR = '.autocode';
    
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

        const targetDir = path.join(this.workspaceRoot, AgentManager.PROJECT_DATA_DIR, 'agents', 'kfc');
        
        try {
            // Ensure target directory exists
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));
            
            // Copy each built-in agent if it does not already exist
            for (const agentName of this.BUILT_IN_AGENTS) {
                const sourcePath = path.join(this.extensionPath, 'dist/resources/agents', `${agentName}.md`);
                const targetPath = path.join(targetDir, `${agentName}.md`);
                
                try {
                    const sourceUri = vscode.Uri.file(sourcePath);
                    const targetUri = vscode.Uri.file(targetPath);
                    try {
                        await vscode.workspace.fs.stat(targetUri);
                        this.outputChannel.appendLine(`[AgentManager] Agent ${agentName} already exists, skipping`);
                        continue;
                    } catch {
                        // File does not exist, copy it below.
                    }

                    await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: false });
                    this.outputChannel.appendLine(`[AgentManager] Copied agent ${agentName}`);
                } catch (error) {
                    this.outputChannel.appendLine(`[AgentManager] Failed to copy agent ${agentName}: ${error}`);
                }
            }
            
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
    async getAgentList(type: 'project' | 'user' | 'all' = 'all'): Promise<AgentInfo[]> {
        const agents: AgentInfo[] = [];

        // Get project agents, including built-in workflow agents under .autocode/agents/kfc.
        if (type === 'project' || type === 'all') {
            if (this.workspaceRoot) {
                const projectAgentsPath = this.joinWorkspacePath(AgentManager.PROJECT_DATA_DIR, 'agents');
                const projectAgents = await this.getAgentsFromDirectory(
                    projectAgentsPath,
                    'project'
                );
                agents.push(...projectAgents);
            }
        }

        // Get user agents
        if (type === 'user' || type === 'all') {
            const userAgentsPath = path.join(os.homedir(), '.claude/agents');
            const userAgents = await this.getAgentsFromDirectory(userAgentsPath, 'user');
            agents.push(...userAgents);
        }

        return agents;
    }

    /**
     * Get agents from a specific directory (including subdirectories)
     */
    private async getAgentsFromDirectory(dirPath: string, type: 'project' | 'user'): Promise<AgentInfo[]> {
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
    private async readAgentsRecursively(dirPath: string, type: 'project' | 'user', agents: AgentInfo[]): Promise<void> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
            
            for (const [fileName, fileType] of entries) {
                const fullPath = path.join(dirPath, fileName);

                if (fileType === vscode.FileType.File && fileName.endsWith('.md')) {
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
    private async parseAgentFile(filePath: string, type: 'project' | 'user'): Promise<AgentInfo | null> {
        try {
            this.outputChannel.appendLine(`[AgentManager] Parsing agent file: ${filePath}`);
            const content = await fs.promises.readFile(filePath, 'utf8');
            
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
            ? (this.workspaceRoot ? this.joinWorkspacePath(AgentManager.PROJECT_DATA_DIR, 'agents', 'kfc') : null)
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
            const projectPath = this.joinWorkspacePath(AgentManager.PROJECT_DATA_DIR, 'agents', 'kfc', `${agentName}.md`);
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
}
