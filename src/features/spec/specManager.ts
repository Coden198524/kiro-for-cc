import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { ConfigManager } from '../../utils/configManager';
import { NotificationUtils } from '../../utils/notificationUtils';
import { PromptLoader } from '../../services/promptLoader';
import { TaskInvocationMode, TaskSessionManager } from './taskSessionManager';
import { parseSpecTaskLine } from './taskStatus';

export type SpecDocumentType = 'requirements' | 'design' | 'tasks';

export interface TaskImplementationRun {
    terminal: vscode.Terminal;
    completionSignalPath?: string;
    completionSignalPaths?: string[];
}

interface RunnableTask {
    lineNumber: number;
    description: string;
    status: 'pending' | 'inProgress';
    completionSignalPath: string;
}

export class SpecManager {
    private configManager: ConfigManager;
    private promptLoader: PromptLoader;

    constructor(
        private agentRuntime: AgentRuntime,
        private outputChannel: vscode.OutputChannel,
        private taskSessionManager?: TaskSessionManager
    ) {
        this.configManager = ConfigManager.getInstance();
        this.configManager.loadSettings();
        this.promptLoader = PromptLoader.getInstance();
    }

    public async getSpecBasePath(): Promise<string> {
        await this.configManager.loadSettings();
        return this.configManager.getPath('specs');
    }

    async create() {
        // Get feature description only
        const description = await vscode.window.showInputBox({
            title: '✨ Create New Spec ✨',
            prompt: 'Specs are a structured way to build features so you can plan before building',
            placeHolder: 'Enter your idea to generate requirement, design, and task specs...',
            ignoreFocusOut: false
        });

        if (!description) {
            return;
        }

        await this.createFromDescription(description, false);
    }

    async createWithAgents() {
        // Get feature description only
        const description = await vscode.window.showInputBox({
            title: '✨ Create New Spec with Agents ✨',
            prompt: 'This will use specialized subagents for creating requirements, design, and tasks',
            placeHolder: 'Enter your idea to generate requirement, design, and task specs...',
            ignoreFocusOut: false
        });

        if (!description) {
            return;
        }

        await this.agentRuntime.refreshProvider?.();

        if (!this.agentRuntime.provider.capabilities.expertAgents) {
            vscode.window.showWarningMessage(`Specialized agents are unavailable for ${this.agentRuntime.provider.displayName}. Creating a standard spec instead.`);
            await this.createFromDescription(description, false);
            return;
        }

        await this.createFromDescription(description, true);
    }

    private async createFromDescription(description: string, useAgents: boolean) {
        await this.agentRuntime.refreshProvider?.();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        // Show notification immediately after user input
        const notification = useAgents
            ? `${this.agentRuntime.provider.displayName} is creating your spec with specialized agents. Check the terminal for progress.`
            : `${this.agentRuntime.provider.displayName} is creating your spec. Check the terminal for progress.`;
        NotificationUtils.showAutoDismissNotification(notification);

        // Let the active agent handle directory creation, naming, and file creation.
        const specBasePath = await this.getSpecBasePath();
        const agentContext = useAgents ? this.getExpertAgentPromptContext(workspaceFolder.uri.fsPath) : {};
        const prompt = this.promptLoader.renderPrompt(useAgents ? 'create-spec-with-agents' : 'create-spec', {
            description,
            workspacePath: workspaceFolder.uri.fsPath,
            specBasePath,
            ...agentContext
        });

        // Send to the active agent and get the terminal.
        const terminal = await this.agentRuntime.invokeInteractive({
            prompt,
            title: useAgents ? 'KFC - Creating Spec (Agents)' : 'KFC - Creating Spec',
            agentType: useAgents ? 'spec_with_agents' : 'spec_orchestrator'
        });

        // Set up automatic terminal renaming when spec folder is created
        this.setupSpecFolderWatcher(workspaceFolder, terminal).catch(error => {
            this.outputChannel.appendLine(`[SpecManager] Failed to set up watcher: ${error}`);
        });
    }

    async implTask(taskFilePath: string, taskDescription: string, resume = false, lineNumber?: number): Promise<TaskImplementationRun | undefined> {
        await this.agentRuntime.refreshProvider?.();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        // Show notification immediately after user input
        NotificationUtils.showAutoDismissNotification(`${this.agentRuntime.provider.displayName} is implementing your task. Check the terminal for progress.`);

        const completionSignalPath = lineNumber !== undefined
            ? this.getCompletionSignalPath(taskFilePath, lineNumber)
            : undefined;
        if (completionSignalPath) {
            await this.prepareCompletionSignalFile(completionSignalPath);
        }

        const languagePreference = await this.detectTaskLanguagePreference(taskFilePath, taskDescription);
        const taskModeInstruction = this.getTaskModeInstruction(resume, languagePreference);
        const languageInstruction = [
            `Use ${languagePreference} for all conversational responses, implementation summaries, task progress updates, and any generated documentation prose.`,
            'Preserve code identifiers, file names, API names, commands, logs, and existing project terminology in their required technical form.'
        ].join(' ');
        const completionSignalInstruction = this.getCompletionSignalInstruction(
            taskFilePath,
            taskDescription,
            lineNumber,
            completionSignalPath
        );

        const prompt = this.promptLoader.renderPrompt('impl-task', {
            taskFilePath,
            taskDescription,
            taskMode: resume ? 'resume' : 'start',
            taskModeInstruction,
            languagePreference,
            languageInstruction,
            completionSignalPath: completionSignalPath || '(not available)',
            completionSignalInstruction
        });

        const terminal = await this.agentRuntime.invokeInteractive({
            prompt,
            title: 'KFC - Implementing Task',
            agentType: 'task_implementer',
            reuseTerminal: true
        });

        if (this.taskSessionManager && lineNumber !== undefined) {
            const mode: TaskInvocationMode = resume ? 'resume' : 'start';
            await this.taskSessionManager.recordInvocation({
                taskFilePath,
                lineNumber,
                taskDescription,
                mode,
                provider: this.agentRuntime.provider,
                prompt,
                terminal
            });
        }

        return { terminal, completionSignalPath };
    }

    private getExpertAgentPromptContext(workspacePath: string): Record<string, string> {
        const provider = this.agentRuntime.provider;

        if (provider.id === 'codex') {
            const codexAgentsPath = path.join(workspacePath, '.codex', 'agents');
            const codexConfigPath = path.join(workspacePath, '.codex', 'config.toml');
            return {
                providerName: provider.displayName,
                agentDirectory: codexAgentsPath,
                agentConfigPath: codexConfigPath,
                agentInvocationInstruction: [
                    'Use the Codex expert agents configured under the project `.codex/agents` directory when your runtime exposes subagents.',
                    'Match each workflow phase to these agent names: spec-requirements, spec-design, spec-tasks, spec-judge, spec-impl, and spec-test.',
                    'If the current Codex runtime cannot spawn a subagent directly, read the matching `.toml` file and apply its `developer_instructions` as the role instructions for that phase.'
                ].join('\n')
            };
        }

        return {
            providerName: provider.displayName,
            agentDirectory: path.join(workspacePath, '.autocode', 'agents', 'kfc'),
            agentConfigPath: '(not required)',
            agentInvocationInstruction: [
                'Use the Claude/AutoCode project agents under `.autocode/agents/kfc` when your runtime exposes subagents.',
                'Match each workflow phase to these agent names: spec-requirements, spec-design, spec-tasks, spec-judge, spec-impl, and spec-test.',
                'If direct subagent spawning is unavailable, read the matching `.md` file and apply its instructions as the role instructions for that phase.'
            ].join('\n')
        };
    }

    async implAllTasks(taskFilePath: string): Promise<TaskImplementationRun | undefined> {
        await this.agentRuntime.refreshProvider?.();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        const tasks = await this.getRunnableTasks(taskFilePath);
        if (tasks.length === 0) {
            vscode.window.showInformationMessage('No pending or in-progress spec tasks found.');
            return undefined;
        }

        NotificationUtils.showAutoDismissNotification(`${this.agentRuntime.provider.displayName} is implementing all remaining tasks. Check the terminal for progress.`);

        for (const task of tasks) {
            await this.prepareCompletionSignalFile(task.completionSignalPath);
        }

        const combinedDescription = tasks.map(task => task.description).join('\n');
        const languagePreference = await this.detectTaskLanguagePreference(taskFilePath, combinedDescription);
        const languageInstruction = [
            `Use ${languagePreference} for all conversational responses, implementation summaries, task progress updates, and any generated documentation prose.`,
            'Preserve code identifiers, file names, API names, commands, logs, and existing project terminology in their required technical form.'
        ].join(' ');

        const prompt = this.buildAllTasksPrompt(taskFilePath, tasks, languagePreference, languageInstruction);
        const terminal = await this.agentRuntime.invokeInteractive({
            prompt,
            title: 'KFC - Implementing All Tasks',
            agentType: 'task_implementer',
            reuseTerminal: true
        });

        if (this.taskSessionManager) {
            for (const task of tasks) {
                await this.taskSessionManager.recordInvocation({
                    taskFilePath,
                    lineNumber: task.lineNumber,
                    taskDescription: task.description,
                    mode: task.status === 'inProgress' ? 'resume' : 'start',
                    provider: this.agentRuntime.provider,
                    prompt,
                    terminal
                });
            }
        }

        return {
            terminal,
            completionSignalPaths: tasks.map(task => task.completionSignalPath)
        };
    }

    private async getRunnableTasks(taskFilePath: string): Promise<RunnableTask[]> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(taskFilePath));
        const tasks: RunnableTask[] = [];

        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
            const task = parseSpecTaskLine(document.lineAt(lineNumber).text);
            if (!task || task.status === 'completed') {
                continue;
            }

            tasks.push({
                lineNumber,
                description: task.description,
                status: task.status,
                completionSignalPath: this.getCompletionSignalPath(taskFilePath, lineNumber)
            });
        }

        return tasks;
    }

    private buildAllTasksPrompt(
        taskFilePath: string,
        tasks: RunnableTask[],
        languagePreference: string,
        languageInstruction: string
    ): string {
        const taskLines = tasks.map(task => [
            `- Line ${task.lineNumber + 1}: ${task.description}`,
            `  Status: ${task.status}`,
            `  Completion signal path: ${task.completionSignalPath}`
        ].join('\n')).join('\n');

        const signalPayloads = tasks.map(task => [
            `For line ${task.lineNumber + 1}, write this JSON to ${task.completionSignalPath}:`,
            JSON.stringify({
                status: 'ready_for_verification',
                taskFilePath,
                lineNumber: task.lineNumber,
                taskDescription: task.description
            }, null, 2)
        ].join('\n')).join('\n\n');

        return [
            '<user_input>',
            'Implement all remaining tasks from this spec task file in one continuous coding session.',
            '',
            `Task File Path: ${taskFilePath}`,
            `Language Preference: ${languagePreference}`,
            '',
            'Language rules:',
            languageInstruction,
            '',
            'Tasks to implement, in order:',
            taskLines,
            '',
            'Execution rules:',
            '1. First read tasks.md, requirements.md, and design.md from the spec folder.',
            '2. Implement each listed task in order.',
            '3. Keep the work scoped to these tasks and avoid unrelated refactors.',
            '4. Add or update focused tests as appropriate.',
            '5. After each task is fully implemented, write its completion signal JSON file.',
            '6. Do not edit task checkboxes yourself. The extension will independently verify and mark completed tasks.',
            '',
            'Completion signals:',
            signalPayloads,
            '</user_input>'
        ].join('\n');
    }

    private getCompletionSignalPath(taskFilePath: string, lineNumber: number): string {
        return path.join(path.dirname(taskFilePath), '.autocode', `task-completion-${lineNumber + 1}.json`);
    }

    private async prepareCompletionSignalFile(completionSignalPath: string): Promise<void> {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(completionSignalPath)));
        try {
            await vscode.workspace.fs.delete(vscode.Uri.file(completionSignalPath));
        } catch {
            // The signal file normally does not exist before a task run.
        }
    }

    private getCompletionSignalInstruction(
        taskFilePath: string,
        taskDescription: string,
        lineNumber: number | undefined,
        completionSignalPath: string | undefined
    ): string {
        if (lineNumber === undefined || !completionSignalPath) {
            return 'No completion signal file is available for this invocation. Finish with a clear summary; the user may mark the task manually.';
        }

        const payload = JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber,
            taskDescription
        }, null, 2);

        return [
            'When you believe this task is fully implemented, create or overwrite the completion signal file with the JSON object below.',
            'The VS Code extension will run an independent model verification and will mark the task checkbox as completed only if verification passes.',
            'Do not edit the task checkbox yourself.',
            '',
            `Completion signal path: ${completionSignalPath}`,
            '',
            payload
        ].join('\n');
    }

    private async detectTaskLanguagePreference(taskFilePath: string, taskDescription: string): Promise<string> {
        const specDir = path.dirname(taskFilePath);
        const candidates = [
            taskDescription,
            await this.readTextIfExists(path.join(specDir, 'tasks.md')),
            await this.readTextIfExists(path.join(specDir, 'requirements.md')),
            await this.readTextIfExists(path.join(specDir, 'design.md'))
        ].filter((content): content is string => Boolean(content));

        return this.inferLanguagePreference(candidates.join('\n'));
    }

    private async readTextIfExists(filePath: string): Promise<string | undefined> {
        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
            return Buffer.from(content).toString();
        } catch {
            return undefined;
        }
    }

    private inferLanguagePreference(text: string): string {
        const chineseCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
        const japaneseCount = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
        const koreanCount = (text.match(/[\uac00-\ud7af]/g) ?? []).length;
        const latinWordCount = (text.match(/[A-Za-z]{3,}/g) ?? []).length;

        if (chineseCount >= 2 && chineseCount >= japaneseCount && chineseCount >= koreanCount) {
            return 'Chinese (中文)';
        }

        if (japaneseCount >= 8 && japaneseCount >= koreanCount) {
            return 'Japanese (日本語)';
        }

        if (koreanCount >= 8) {
            return 'Korean (한국어)';
        }

        if (latinWordCount >= 8) {
            return 'English';
        }

        return 'the primary natural language used by the referenced spec documents and task description';
    }

    private getTaskModeInstruction(resume: boolean, languagePreference: string): string {
        if (languagePreference.startsWith('Chinese')) {
            return resume
                ? '继续这个进行中的任务。先检查当前工作区变更、任务文件、requirements.md、design.md 以及已有的部分实现。识别已经完成的内容，避免重复工作，然后从当前状态继续。'
                : '从当前 spec 上下文开始执行这个任务。扩展在启动此代理前已经把任务标记为进行中。';
        }

        return resume
            ? 'Resume this in-progress task. First inspect the current worktree, the task file, requirements.md, design.md, and any existing partial implementation. Identify what has already been completed, avoid repeating completed work, then continue from the current state.'
            : 'Start this task from its current spec context. The extension has marked it in progress before launching this agent.';
    }

    /**
     * Set up a file system watcher to automatically rename the terminal 
     * when a new spec folder is created
     */
    private async setupSpecFolderWatcher(workspaceFolder: vscode.WorkspaceFolder, terminal: vscode.Terminal): Promise<void> {
        // Create watcher for new folders in the specs directory
        const specBasePath = await this.getSpecBasePath();
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolder, `${specBasePath}/*`),
            false, // Watch for creates
            true,  // Ignore changes
            true   // Ignore deletes
        );

        let disposed = false;

        // Handle folder creation
        const disposable = watcher.onDidCreate(async (uri) => {
            if (disposed) return;

            // Validate it's a directory
            try {
                const stats = await vscode.workspace.fs.stat(uri);
                if (stats.type !== vscode.FileType.Directory) {
                    this.outputChannel.appendLine(`[SpecManager] Skipping non-directory: ${uri.fsPath}`);
                    return;
                }
            } catch (error) {
                this.outputChannel.appendLine(`[SpecManager] Error checking path: ${error}`);
                return;
            }

            const specName = path.basename(uri.fsPath);
            this.outputChannel.appendLine(`[SpecManager] New spec detected: ${specName}`);
            try {
                await this.agentRuntime.renameTerminal(terminal, `Spec: ${specName}`);
            } catch (error) {
                this.outputChannel.appendLine(`[SpecManager] Failed to rename terminal: ${error}`);
            }

            // Clean up after successful rename
            this.disposeWatcher(disposable, watcher);
            disposed = true;
        });

        // Auto-cleanup after timeout
        setTimeout(() => {
            if (!disposed) {
                this.outputChannel.appendLine(`[SpecManager] Watcher timeout - cleaning up`);
                this.disposeWatcher(disposable, watcher);
                disposed = true;
            }
        }, 60000); // 60 seconds timeout
    }

    /**
     * Dispose watcher and its event handler
     */
    private disposeWatcher(disposable: vscode.Disposable, watcher: vscode.FileSystemWatcher): void {
        disposable.dispose();
        watcher.dispose();
        this.outputChannel.appendLine(`[SpecManager] Watcher disposed`);
    }

    async navigateToDocument(specName: string, type: SpecDocumentType) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const specBasePath = await this.getSpecBasePath();
        const docPath = path.join(
            workspaceFolder.uri.fsPath,
            specBasePath,
            specName,
            `${type}.md`
        );

        try {
            const doc = await vscode.workspace.openTextDocument(docPath);
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            // File doesn't exist, look for already open virtual documents
            // Create unique identifier for this spec document
            const uniqueMarker = `<!-- kiro-spec: ${specName}/${type} -->`;

            for (const doc of vscode.workspace.textDocuments) {
                // Check if this is an untitled document with our unique marker
                if (doc.isUntitled && doc.getText().includes(uniqueMarker)) {
                    // Found our specific virtual document, show it
                    await vscode.window.showTextDocument(doc, {
                        preview: false,
                        viewColumn: vscode.ViewColumn.Active
                    });
                    return;
                }
            }

            // No existing virtual document found, create a new one
            let placeholderContent = `${uniqueMarker}
# ${type.charAt(0).toUpperCase() + type.slice(1)} Document

This document has not been created yet.`;

            if (type === 'design') {
                placeholderContent += '\n\nPlease approve the requirements document first.';
            } else if (type === 'tasks') {
                placeholderContent += '\n\nPlease approve the design document first.';
            } else if (type === 'requirements') {
                placeholderContent += '\n\nRun "Create New Spec" to generate this document.';
            }

            // Create a new untitled document
            const doc = await vscode.workspace.openTextDocument({
                content: placeholderContent,
                language: 'markdown'
            });

            // Show it
            await vscode.window.showTextDocument(doc, {
                preview: false,
                viewColumn: vscode.ViewColumn.Active
            });
        }
    }

    async delete(specName: string): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const specBasePath = await this.getSpecBasePath();
        const specPath = path.join(
            workspaceFolder.uri.fsPath,
            specBasePath,
            specName
        );

        try {
            await vscode.workspace.fs.delete(vscode.Uri.file(specPath), { recursive: true });
            await NotificationUtils.showAutoDismissNotification(`Spec "${specName}" deleted successfully`);
        } catch (error) {
            this.outputChannel.appendLine(`[SpecManager] Failed to delete spec: ${error}`);
            vscode.window.showErrorMessage(`Failed to delete spec: ${error}`);
        }
    }

    async getSpecList(): Promise<string[]> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return [];
        }

        const specBasePath = await this.getSpecBasePath();
        const specsPath = path.join(workspaceFolder.uri.fsPath, specBasePath);

        // Check if directory exists first before creating
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(specsPath));
        } catch {
            // Directory doesn't exist, create it
            try {
                this.outputChannel.appendLine(`[SpecManager] Creating ${specBasePath} directory`);
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(specsPath)));
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(specsPath));
            } catch {
                // Ignore errors
            }
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(specsPath));
            return entries
                .filter(([, type]) => type === vscode.FileType.Directory)
                .map(([name]) => name);
        } catch (error) {
            // Directory doesn't exist yet
            return [];
        }
    }
}
