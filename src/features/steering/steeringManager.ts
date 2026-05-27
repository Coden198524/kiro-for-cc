import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { ConfigManager } from '../../utils/configManager';
import { NotificationUtils } from '../../utils/notificationUtils';
import { PromptLoader } from '../../services/promptLoader';

export class SteeringManager {
    private configManager: ConfigManager;
    private promptLoader: PromptLoader;

    constructor(
        private agentRuntime: AgentRuntime,
        private outputChannel: vscode.OutputChannel
    ) {
        this.configManager = ConfigManager.getInstance();
        this.configManager.loadSettings();
        this.promptLoader = PromptLoader.getInstance();
    }

    public getSteeringBasePath(): string {
        return this.configManager.getPath('steering');
    }

    async createCustom() {
        await this.agentRuntime.refreshProvider?.();

        // Get project context and guidance needs
        const description = await vscode.window.showInputBox({
            title: '📝 Create Steering Document 📝',
            prompt: 'Describe what guidance you need for your project',
            placeHolder: 'e.g., API design patterns for REST endpoints, testing strategy for React components',
            ignoreFocusOut: false
        });

        if (!description) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        // Create steering directory if it doesn't exist
        const steeringPath = path.join(workspaceFolder.uri.fsPath, this.getSteeringBasePath());

        try {
            // Ensure directory exists
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(steeringPath));

            // Let Claude decide the filename based on the description
            const prompt = this.promptLoader.renderPrompt('create-custom-steering', {
                description,
                steeringPath: this.getSteeringBasePath()
            });

            await this.agentRuntime.invokeInteractive({
                prompt,
                title: 'AutoCode - Create Steering',
                agentType: 'steering_writer'
            });

            // Show auto-dismiss notification
            await NotificationUtils.showAutoDismissNotification(`${this.agentRuntime.provider.displayName} is creating a steering document based on your needs. Check the terminal for progress.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create steering document: ${error}`);
        }
    }

    /**
     * Delete a steering document and update CLAUDE.md
     */
    async delete(documentName: string, documentPath: string): Promise<{ success: boolean; error?: string }> {
        await this.agentRuntime.refreshProvider?.();

        try {
            // First delete the file
            await vscode.workspace.fs.delete(vscode.Uri.file(documentPath));

            // Load and render the delete prompt
            const prompt = this.promptLoader.renderPrompt('delete-steering', {
                documentName: documentName,
                steeringPath: this.getSteeringBasePath()
            });

            // Show progress notification
            await NotificationUtils.showAutoDismissNotification(`Deleting "${documentName}" and updating steering references...`);

            // Execute the active agent command to update CLAUDE.md if needed.
            const result = await this.agentRuntime.invokeHeadless({
                prompt,
                title: 'AutoCode - Delete Steering',
                agentType: 'steering_deleter'
            });

            if (result.exitCode === 0) {
                await NotificationUtils.showAutoDismissNotification(`Steering document "${documentName}" deleted and CLAUDE.md updated successfully.`);
                return { success: true };
            } else if (result.exitCode !== undefined) {
                const error = `Failed to update CLAUDE.md. Exit code: ${result.exitCode}`;
                this.outputChannel.appendLine(`[Steering] ${error}`);
                return { success: false, error };
            } else {
                return { success: true }; // Assume success if no exit code
            }
        } catch (error) {
            const errorMsg = `Failed to delete steering document: ${error}`;
            this.outputChannel.appendLine(`[Steering] ${errorMsg}`);
            return { success: false, error: errorMsg };
        }
    }

    /**
    * Generate initial steering documents by analyzing the project
    */
    async init() {
        await this.agentRuntime.refreshProvider?.();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        // Check if steering documents already exist
        const existingDocs = await this.getSteeringDocuments();
        if (existingDocs.length > 0) {
            const existingNames = existingDocs.map(doc => doc.name).join(', ');
            const confirm = await vscode.window.showWarningMessage(
                `Project context documents already exist (${existingNames}). Initialize Project Context will analyze the project again but won't overwrite existing files.`,
                'Continue',
                'Cancel'
            );
            if (confirm !== 'Continue') {
                return;
            }
        }

        // Create steering directory if it doesn't exist
        const steeringPath = path.join(workspaceFolder.uri.fsPath, this.getSteeringBasePath());
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(steeringPath));

        // Generate steering documents using Claude
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Analyzing project and generating project context documents...',
            cancellable: false
        }, async () => {
            const prompt = this.promptLoader.renderPrompt('init-steering', {
                steeringPath: this.getSteeringBasePath()
            });

            await this.agentRuntime.invokeInteractive({
                prompt,
                title: 'Initialize Project Context',
                agentType: 'steering_initializer'
            });

            // Auto-dismiss notification after 3 seconds
            await NotificationUtils.showAutoDismissNotification('Project context initialization started. Check the terminal for progress.');
        });
    }

    async refine(uri: vscode.Uri) {
        await this.agentRuntime.refreshProvider?.();

        // Load and render the refine prompt
        const prompt = this.promptLoader.renderPrompt('refine-steering', {
            filePath: uri.fsPath
        });

        // Send to the active agent.
        await this.agentRuntime.invokeInteractive({
            prompt,
            title: 'AutoCode - Refine Steering',
            agentType: 'steering_refiner'
        });

        // Show auto-dismiss notification
        await NotificationUtils.showAutoDismissNotification(`${this.agentRuntime.provider.displayName} is refining the steering document. Check the terminal for progress.`);
    }

    async getSteeringDocuments(): Promise<Array<{ name: string, path: string }>> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return [];
        }

        const steeringPath = path.join(workspaceFolder.uri.fsPath, this.getSteeringBasePath());

        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(steeringPath));
            return entries
                .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
                .map(([name]) => ({
                    name: name.replace('.md', ''),
                    path: path.join(steeringPath, name)
                }));
        } catch (error) {
            // Directory doesn't exist yet
            return [];
        }
    }

    /**
     * Create project-level CLAUDE.md file using Claude CLI
     */
    async createProjectClaudeMd() {
        await this.agentRuntime.refreshProvider?.();

        if (!this.agentRuntime.provider.capabilities.permissions) {
            vscode.window.showWarningMessage('Project CLAUDE.md initialization is only available when the active provider is Claude Code.');
            return;
        }

        const terminal = vscode.window.createTerminal({
            name: 'Claude Code - Init',
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            location: {
                viewColumn: vscode.ViewColumn.Two
            }
        });
        terminal.show();

        // Wait for Python extension to finish venv activation
        const delay = this.configManager.getTerminalDelay();
        setTimeout(() => {
            terminal.sendText(`${this.agentRuntime.provider.command} --permission-mode bypassPermissions "/init"`);
        }, delay);
    }

    /**
     * Create global CLAUDE.md file in user's home directory
     */
    async createUserClaudeMd() {
        await this.agentRuntime.refreshProvider?.();

        if (!this.agentRuntime.provider.capabilities.permissions) {
            vscode.window.showWarningMessage('Global CLAUDE.md creation is only available when the active provider is Claude Code.');
            return;
        }

        const claudeDir = path.join(process.env.HOME || '', '.claude');
        const filePath = path.join(claudeDir, 'CLAUDE.md');

        // Ensure directory exists
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(claudeDir));
        } catch (error) {
            // Directory might already exist
        }

        // Check if file already exists
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
            const overwrite = await vscode.window.showWarningMessage(
                'Global CLAUDE.md already exists. Overwrite?',
                'Overwrite',
                'Cancel'
            );
            if (overwrite !== 'Overwrite') {
                return;
            }
        } catch {
            // File doesn't exist, continue
        }

        // Create empty file
        const initialContent = '';
        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(filePath),
            Buffer.from(initialContent)
        );

        // Open the file
        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document);

        // Auto-dismiss notification
        await NotificationUtils.showAutoDismissNotification('Created global CLAUDE.md file');
    }





}
