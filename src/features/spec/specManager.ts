import * as vscode from 'vscode';
import * as path from 'path';
import { AgentApprovalPolicy, AgentRuntime } from '../../runtime/agentRuntime';
import { ConfigManager } from '../../utils/configManager';
import { NotificationUtils } from '../../utils/notificationUtils';
import { PromptLoader } from '../../services/promptLoader';
import { TaskInvocationMode, TaskSessionManager } from './taskSessionManager';
import { hasChildSpecTasks, parseSpecTaskLine, SpecTaskStatus } from './taskStatus';
import { analyzeTaskPlanQuality, formatTaskPlanQualityIssue } from './taskPlanQuality';
import { AgentManager, CodexAgentsReadyResult } from '../agents/agentManager';

export type SpecDocumentType = 'requirements' | 'design' | 'tasks';

export interface ParallelTaskImplementationRun {
    terminal: vscode.Terminal;
    taskFilePath: string;
    lineNumber: number;
    taskDescription: string;
    completionSignalPath: string;
}

export interface TaskImplementationRun {
    terminal?: vscode.Terminal;
    completionSignalPath?: string;
    completionSignalPaths?: string[];
    parallelRuns?: ParallelTaskImplementationRun[];
    failedLineNumbers?: number[];
    lineNumber?: number;
    taskDescription?: string;
}

export interface TaskImplementationLaunchTask {
    lineNumber: number;
    taskDescription: string;
    status: 'pending' | 'inProgress';
    completionSignalPath: string;
}

export interface TaskImplementationLaunchOptions {
    beforeLaunchTasks?: (tasks: readonly TaskImplementationLaunchTask[]) => Promise<void>;
}

interface RunnableTask {
    lineNumber: number;
    description: string;
    status: 'pending' | 'inProgress';
    completionSignalPath: string;
    detailLines: string[];
    taskId?: string;
    dependencies?: string[];
    hasExplicitDependencies: boolean;
}

interface ParallelTaskScope {
    task: RunnableTask;
    fileScopes: string[];
}

interface ParallelTaskAnalysis {
    canRunInParallel: boolean;
    fallbackReason?: string;
    scopes: ParallelTaskScope[];
    readyScopes: ParallelTaskScope[];
    blockedTaskCount: number;
}

interface RunnableTaskContext {
    tasks: RunnableTask[];
    taskStatusesById: Map<string, SpecTaskStatus>;
}

interface ImplTaskOptions {
    reuseTerminal?: boolean;
    notification?: boolean;
    title?: string;
    parallelFileScopes?: string[];
    approvalPolicy?: AgentApprovalPolicy;
}

export class SpecManager {
    private configManager: ConfigManager;
    private promptLoader: PromptLoader;
    private reportedTaskPlanQualityPaths = new Set<string>();

    constructor(
        private agentRuntime: AgentRuntime,
        private outputChannel: vscode.OutputChannel,
        private taskSessionManager?: TaskSessionManager,
        private agentManager?: AgentManager
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

        const agentReadiness = await this.ensureExpertAgentsReady();
        if (agentReadiness === null) {
            return;
        }

        await this.createFromDescription(description, true, agentReadiness);
    }

    private async createFromDescription(
        description: string,
        useAgents: boolean,
        codexAgentReadiness?: CodexAgentsReadyResult
    ) {
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
        const agentContext = useAgents ? this.getExpertAgentPromptContext(workspaceFolder.uri.fsPath, codexAgentReadiness) : {};
        const prompt = this.promptLoader.renderPrompt(useAgents ? 'create-spec-with-agents' : 'create-spec', {
            description,
            workspacePath: workspaceFolder.uri.fsPath,
            specBasePath,
            ...agentContext
        });

        // Send to the active agent and get the terminal.
        const terminal = await this.agentRuntime.invokeInteractive({
            prompt,
            title: useAgents ? 'AutoCode - Creating Spec (Agents)' : 'AutoCode - Creating Spec',
            agentType: useAgents ? 'spec_with_agents' : 'spec_orchestrator'
        });

        // Set up automatic terminal renaming when spec folder is created
        this.setupSpecFolderWatcher(workspaceFolder, terminal).catch(error => {
            this.outputChannel.appendLine(`[SpecManager] Failed to set up watcher: ${error}`);
        });
    }

    async implTask(
        taskFilePath: string,
        taskDescription: string,
        resume = false,
        lineNumber?: number,
        options: ImplTaskOptions = {}
    ): Promise<TaskImplementationRun | undefined> {
        await this.agentRuntime.refreshProvider?.();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        // Show notification immediately after user input
        if (options.notification !== false) {
            NotificationUtils.showAutoDismissNotification(`${this.agentRuntime.provider.displayName} is implementing your task. Check the terminal for progress.`);
        }

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
        const providerExecutionGuidance = [
            this.getProviderTaskExecutionGuidance(),
            this.getParallelTaskExecutionGuidance(options.parallelFileScopes)
        ].filter(Boolean).join('\n');
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
            providerExecutionGuidance,
            completionSignalPath: completionSignalPath || '(not available)',
            completionSignalInstruction
        });

        const terminal = await this.agentRuntime.invokeInteractive({
            prompt,
            title: options.title ?? 'AutoCode - Implementing Task',
            agentType: 'task_implementer',
            reuseTerminal: options.reuseTerminal ?? true,
            approvalPolicy: options.approvalPolicy
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

        return { terminal, completionSignalPath, lineNumber, taskDescription };
    }

    private async ensureExpertAgentsReady(): Promise<CodexAgentsReadyResult | undefined | null> {
        const provider = this.agentRuntime.provider;

        if (provider.id !== 'codex') {
            return undefined;
        }

        if (!this.agentManager) {
            const message = 'Codex expert agents are unavailable because the agent manager is not initialized.';
            this.outputChannel.appendLine(`[SpecManager] ${message}`);
            vscode.window.showErrorMessage(message);
            return null;
        }

        const readiness = await this.agentManager.ensureCodexAgentsReady();
        if (!readiness.ready) {
            const missing = readiness.missingAgents.length > 0
                ? readiness.missingAgents.join(', ')
                : 'none';
            const message = `Codex expert agents are not ready. Missing agents: ${missing}.`;
            this.outputChannel.appendLine(`[SpecManager] ${message}`);
            for (const error of readiness.errors) {
                this.outputChannel.appendLine(`[SpecManager] Codex agent readiness error: ${error}`);
            }
            vscode.window.showErrorMessage(message);
            return null;
        }

        return readiness;
    }

    private getExpertAgentPromptContext(workspacePath: string, codexAgentReadiness?: CodexAgentsReadyResult): Record<string, string> {
        const provider = this.agentRuntime.provider;

        if (provider.id === 'codex') {
            const codexAgentsPath = codexAgentReadiness?.agentsPath ?? path.join(workspacePath, '.codex', 'agents');
            const codexConfigPath = codexAgentReadiness?.configPath ?? path.join(workspacePath, '.codex', 'config.toml');
            return {
                providerName: provider.displayName,
                agentDirectory: codexAgentsPath,
                agentConfigPath: codexConfigPath,
                agentReadiness: codexAgentReadiness
                    ? [
                        'Codex project expert agents were verified before launch.',
                        `Existing agents: ${codexAgentReadiness.existingAgents.join(', ') || 'none'}.`,
                        `Created agents this run: ${codexAgentReadiness.createdAgents.join(', ') || 'none'}.`,
                        'Missing agents: none.'
                    ].join(' ')
                    : 'Codex project expert agents were not verified by this AutoCode session.',
                agentInvocationInstruction: [
                    'Use the Codex expert agents configured under the project `.codex/agents` directory when your runtime exposes subagents or multi-agent tools.',
                    'Match each workflow phase to these agent names: spec-requirements, spec-design, spec-tasks, spec-judge, spec-impl, and spec-test.',
                    'If the current Codex runtime cannot spawn a subagent directly, read the matching `.toml` file and apply its `developer_instructions` as the role instructions for that phase.',
                    'Do not continue with an unscoped generic role. Report whether each phase used native delegation or TOML instruction emulation in terminal progress.'
                ].join('\n')
            };
        }

        return {
            providerName: provider.displayName,
            agentDirectory: path.join(workspacePath, '.autocode', 'agents', 'autocode'),
            agentConfigPath: '(not required)',
            agentReadiness: 'Claude/AutoCode project agent directory is initialized on extension activation when a workspace is open.',
            agentInvocationInstruction: [
                'Use the Claude/AutoCode project agents under `.autocode/agents/autocode` when your runtime exposes subagents.',
                'Match each workflow phase to these agent names: spec-requirements, spec-design, spec-tasks, spec-judge, spec-impl, and spec-test.',
                'If direct subagent spawning is unavailable, read the matching `.md` file and apply its instructions as the role instructions for that phase.'
            ].join('\n')
        };
    }

    async implAllTasks(taskFilePath: string, options: TaskImplementationLaunchOptions = {}): Promise<TaskImplementationRun | undefined> {
        await this.agentRuntime.refreshProvider?.();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        await this.reportTaskPlanQuality(taskFilePath);

        const taskContext = await this.getRunnableTaskContext(taskFilePath);
        const tasks = this.getSequentialTaskOrder(taskContext);
        if (tasks.length === 0) {
            vscode.window.showInformationMessage('No pending or in-progress spec tasks found.');
            return undefined;
        }

        const task = tasks[0];
        NotificationUtils.showAutoDismissNotification(`${this.agentRuntime.provider.displayName} is implementing the next spec task. Auto mode will continue after verification passes.`);

        await options.beforeLaunchTasks?.([this.toLaunchTask(task)]);

        return this.implTask(
            taskFilePath,
            task.description,
            task.status === 'inProgress',
            task.lineNumber,
            {
                title: `AutoCode - Task ${task.lineNumber + 1}`,
                reuseTerminal: true,
                notification: false,
                approvalPolicy: 'never'
            }
        );
    }

    async implAllTasksParallel(taskFilePath: string, options: TaskImplementationLaunchOptions = {}): Promise<TaskImplementationRun | undefined> {
        await this.agentRuntime.refreshProvider?.();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        await this.reportTaskPlanQuality(taskFilePath);

        const taskContext = await this.getRunnableTaskContext(taskFilePath);
        if (taskContext.tasks.length === 0) {
            vscode.window.showInformationMessage('No pending or in-progress spec tasks found.');
            return undefined;
        }

        if (taskContext.tasks.length === 1) {
            vscode.window.showInformationMessage('Only one runnable spec task was found. Running the normal task executor.');
            return this.implAllTasks(taskFilePath, options);
        }

        const analysis = this.analyzeParallelTaskSafety(taskContext);
        if (!analysis.canRunInParallel) {
            vscode.window.showWarningMessage(`Parallel task execution fell back to sequential mode: ${analysis.fallbackReason}`);
            return this.implAllTasks(taskFilePath, options);
        }

        if (analysis.readyScopes.length === 0) {
            vscode.window.showInformationMessage('No spec tasks are ready for parallel execution yet. Complete the prerequisite tasks first.');
            return undefined;
        }

        const blockedMessage = analysis.blockedTaskCount > 0
            ? ` ${analysis.blockedTaskCount} task(s) are waiting for dependencies.`
            : '';
        NotificationUtils.showAutoDismissNotification(`${this.agentRuntime.provider.displayName} is implementing ${analysis.readyScopes.length} ready task(s) in parallel.${blockedMessage} Check the terminals for progress.`);

        const runs: ParallelTaskImplementationRun[] = [];
        const failedLineNumbers: number[] = [];

        for (const scope of analysis.readyScopes) {
            let run: TaskImplementationRun | undefined;
            try {
                await options.beforeLaunchTasks?.([this.toLaunchTask(scope.task)]);
                run = await this.implTask(
                    taskFilePath,
                    scope.task.description,
                    scope.task.status === 'inProgress',
                    scope.task.lineNumber,
                    {
                        reuseTerminal: false,
                        notification: false,
                        title: `AutoCode - Task ${scope.task.lineNumber + 1}`,
                        parallelFileScopes: scope.fileScopes,
                        approvalPolicy: 'never'
                    }
                );
            } catch (error) {
                failedLineNumbers.push(scope.task.lineNumber);
                this.outputChannel.appendLine(`[SpecManager] Failed to start parallel task on line ${scope.task.lineNumber + 1}: ${error}`);
                continue;
            }

            if (!run?.terminal || !run.completionSignalPath) {
                failedLineNumbers.push(scope.task.lineNumber);
                continue;
            }

            runs.push({
                terminal: run.terminal,
                taskFilePath,
                lineNumber: scope.task.lineNumber,
                taskDescription: scope.task.description,
                completionSignalPath: run.completionSignalPath
            });
        }

        if (runs.length === 0) {
            return failedLineNumbers.length > 0
                ? { parallelRuns: [], failedLineNumbers }
                : undefined;
        }

        return {
            parallelRuns: runs,
            failedLineNumbers
        };
    }

    private async getRunnableTasks(taskFilePath: string): Promise<RunnableTask[]> {
        return this.getSequentialTaskOrder(await this.getRunnableTaskContext(taskFilePath));
    }

    private async reportTaskPlanQuality(taskFilePath: string): Promise<void> {
        const normalizedPath = path.normalize(taskFilePath).toLowerCase();
        if (this.reportedTaskPlanQualityPaths.has(normalizedPath)) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(taskFilePath));
        const report = analyzeTaskPlanQuality(this.getDocumentLines(document));
        if (report.issueCount === 0) {
            this.reportedTaskPlanQualityPaths.add(normalizedPath);
            return;
        }

        this.outputChannel.appendLine(`[Task Plan Quality] ${taskFilePath}: ${report.errorCount} error(s), ${report.warningCount} warning(s).`);
        for (const item of report.issues) {
            this.outputChannel.appendLine(`[Task Plan Quality] ${formatTaskPlanQualityIssue(item)}`);
        }

        vscode.window.showWarningMessage(`Task plan quality check found ${report.errorCount} error(s) and ${report.warningCount} warning(s). See AutoCode output for details.`);
        this.reportedTaskPlanQualityPaths.add(normalizedPath);
    }

    private toLaunchTask(task: RunnableTask): TaskImplementationLaunchTask {
        return {
            lineNumber: task.lineNumber,
            taskDescription: task.description,
            status: task.status,
            completionSignalPath: task.completionSignalPath
        };
    }

    private getSequentialTaskOrder(context: RunnableTaskContext): RunnableTask[] {
        const tasks = context.tasks;
        if (tasks.length < 2 || tasks.some(task => !task.hasExplicitDependencies)) {
            return tasks;
        }

        const graphError = this.getTaskDependencyGraphError(
            tasks.map(task => ({ task, fileScopes: [] })),
            context.taskStatusesById
        );
        if (graphError) {
            return tasks;
        }

        const tasksById = new Map<string, RunnableTask>();
        for (const task of tasks) {
            if (!task.taskId) {
                return tasks;
            }

            tasksById.set(task.taskId, task);
        }

        const inDegreeByTaskId = new Map<string, number>();
        const dependentsByTaskId = new Map<string, RunnableTask[]>();
        for (const task of tasks) {
            inDegreeByTaskId.set(task.taskId!, 0);
        }

        for (const task of tasks) {
            for (const dependency of task.dependencies ?? []) {
                if (!tasksById.has(dependency)) {
                    continue;
                }

                inDegreeByTaskId.set(task.taskId!, (inDegreeByTaskId.get(task.taskId!) ?? 0) + 1);
                const dependents = dependentsByTaskId.get(dependency) ?? [];
                dependents.push(task);
                dependentsByTaskId.set(dependency, dependents);
            }
        }

        const readyTasks = tasks.filter(task => (inDegreeByTaskId.get(task.taskId!) ?? 0) === 0);
        const orderedTasks: RunnableTask[] = [];

        while (readyTasks.length > 0) {
            const task = readyTasks.shift()!;
            orderedTasks.push(task);

            for (const dependent of dependentsByTaskId.get(task.taskId!) ?? []) {
                const nextInDegree = (inDegreeByTaskId.get(dependent.taskId!) ?? 0) - 1;
                inDegreeByTaskId.set(dependent.taskId!, nextInDegree);
                if (nextInDegree === 0) {
                    readyTasks.push(dependent);
                }
            }
        }

        return orderedTasks.length === tasks.length ? orderedTasks : tasks;
    }

    private async getRunnableTaskContext(taskFilePath: string): Promise<RunnableTaskContext> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(taskFilePath));
        const tasks: RunnableTask[] = [];
        const lines = this.getDocumentLines(document);
        const taskStatusesById = new Map<string, SpecTaskStatus>();

        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
            const task = parseSpecTaskLine(document.lineAt(lineNumber).text);
            const taskId = task ? this.parseTaskId(task.description) : undefined;
            if (task && taskId) {
                taskStatusesById.set(taskId, task.status);
            }
        }

        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
            const task = parseSpecTaskLine(document.lineAt(lineNumber).text);
            if (!task || task.status === 'completed') {
                continue;
            }

            if (hasChildSpecTasks(lines, lineNumber)) {
                continue;
            }

            const detailLines = this.getTaskDetailLines(lines, lineNumber);
            const dependencyMetadata = this.parseTaskDependencies([task.description, ...detailLines].join('\n'));

            tasks.push({
                lineNumber,
                description: task.description,
                status: task.status,
                completionSignalPath: this.getCompletionSignalPath(taskFilePath, lineNumber),
                detailLines,
                taskId: this.parseTaskId(task.description),
                dependencies: dependencyMetadata.dependencies,
                hasExplicitDependencies: dependencyMetadata.hasExplicitDependencies
            });
        }

        return {
            tasks,
            taskStatusesById
        };
    }

    private getDocumentLines(document: vscode.TextDocument): string[] {
        const lines: string[] = [];
        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
            lines.push(document.lineAt(lineNumber).text);
        }
        return lines;
    }

    private getTaskDetailLines(lines: readonly string[], lineNumber: number): string[] {
        const task = parseSpecTaskLine(lines[lineNumber]);
        if (!task) {
            return [];
        }

        const taskIndent = this.getIndentationWidth(task.indentation);
        const detailLines: string[] = [];

        for (let i = lineNumber + 1; i < lines.length; i++) {
            const candidate = parseSpecTaskLine(lines[i]);
            if (candidate && this.getIndentationWidth(candidate.indentation) <= taskIndent) {
                break;
            }

            detailLines.push(lines[i]);
        }

        return detailLines;
    }

    private getIndentationWidth(indentation: string): number {
        return indentation.replace(/\t/g, '    ').length;
    }

    private parseTaskId(description: string): string | undefined {
        const match = description.trim().match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+/);
        return match?.[1];
    }

    private parseTaskDependencies(text: string): { dependencies?: string[]; hasExplicitDependencies: boolean } {
        const dependencyLine = text
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(line => this.isDependencyMetadataLine(line));

        if (!dependencyLine) {
            return {
                hasExplicitDependencies: false
            };
        }

        const value = dependencyLine.replace(/^(?:[-*]\s*)?(?:_)?(?:depends on|dependencies|depends|blocked by|依赖|前置任务|依赖任务)\s*[:：]\s*/i, '').replace(/_$/, '').trim();
        if (!value || /^(none|n\/a|na|null|empty|无|无依赖|没有|不依赖|-+)$/i.test(value)) {
            return {
                dependencies: [],
                hasExplicitDependencies: true
            };
        }

        const dependencies = [...value.matchAll(/\b\d+(?:\.\d+)*\b/g)]
            .map(match => match[0])
            .filter((dependency, index, all) => all.indexOf(dependency) === index);

        return {
            dependencies,
            hasExplicitDependencies: true
        };
    }

    private analyzeParallelTaskSafety(context: RunnableTaskContext): ParallelTaskAnalysis {
        const scopes = context.tasks.map(task => ({
            task,
            fileScopes: this.extractReferencedFileScopes(this.getTaskScopeText(task))
        }));
        const legacyMode = scopes.every(scope => !scope.task.hasExplicitDependencies);
        const readyScopes = legacyMode
            ? scopes
            : this.getReadyParallelScopes(scopes, context.taskStatusesById);

        if (!legacyMode && scopes.some(scope => !scope.task.hasExplicitDependencies)) {
            return {
                canRunInParallel: false,
                fallbackReason: 'task dependency metadata is incomplete',
                scopes,
                readyScopes: [],
                blockedTaskCount: scopes.length
            };
        }

        if (!legacyMode) {
            const graphError = this.getTaskDependencyGraphError(scopes, context.taskStatusesById);
            if (graphError) {
                return {
                    canRunInParallel: false,
                    fallbackReason: graphError,
                    scopes,
                    readyScopes: [],
                    blockedTaskCount: scopes.length
                };
            }
        }

        for (const scope of readyScopes) {
            if (scope.fileScopes.length === 0) {
                return {
                    canRunInParallel: false,
                    fallbackReason: `line ${scope.task.lineNumber + 1} has no explicit file scope`,
                    scopes,
                    readyScopes,
                    blockedTaskCount: scopes.length - readyScopes.length
                };
            }

            const sharedScope = scope.fileScopes.find(fileScope => this.isSharedConflictScope(fileScope));
            if (sharedScope) {
                return {
                    canRunInParallel: false,
                    fallbackReason: `line ${scope.task.lineNumber + 1} touches shared project file ${sharedScope}`,
                    scopes,
                    readyScopes,
                    blockedTaskCount: scopes.length - readyScopes.length
                };
            }

            const broadRisk = this.getBroadParallelRisk(scope.task);
            if (broadRisk) {
                return {
                    canRunInParallel: false,
                    fallbackReason: `line ${scope.task.lineNumber + 1} looks cross-cutting (${broadRisk})`,
                    scopes,
                    readyScopes,
                    blockedTaskCount: scopes.length - readyScopes.length
                };
            }
        }

        for (let i = 0; i < readyScopes.length; i++) {
            for (let j = i + 1; j < readyScopes.length; j++) {
                const overlap = this.findOverlappingFileScope(readyScopes[i].fileScopes, readyScopes[j].fileScopes);
                if (overlap) {
                    return {
                        canRunInParallel: false,
                        fallbackReason: `lines ${readyScopes[i].task.lineNumber + 1} and ${readyScopes[j].task.lineNumber + 1} both target ${overlap}`,
                        scopes,
                        readyScopes,
                        blockedTaskCount: scopes.length - readyScopes.length
                    };
                }
            }
        }

        return {
            canRunInParallel: true,
            scopes,
            readyScopes,
            blockedTaskCount: scopes.length - readyScopes.length
        };
    }

    private getReadyParallelScopes(scopes: ParallelTaskScope[], taskStatusesById: Map<string, SpecTaskStatus>): ParallelTaskScope[] {
        const runnableTaskIds = new Set(scopes.map(scope => scope.task.taskId).filter((taskId): taskId is string => Boolean(taskId)));

        return scopes.filter(scope => {
            const dependencies = scope.task.dependencies ?? [];
            return dependencies.every(dependency => {
                if (runnableTaskIds.has(dependency)) {
                    return false;
                }

                return taskStatusesById.get(dependency) === 'completed';
            });
        });
    }

    private getTaskDependencyGraphError(scopes: ParallelTaskScope[], taskStatusesById: Map<string, SpecTaskStatus>): string | undefined {
        const runnableTaskIds = new Set(scopes.map(scope => scope.task.taskId).filter((taskId): taskId is string => Boolean(taskId)));
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const dependenciesByTaskId = new Map<string, string[]>();

        for (const scope of scopes) {
            if (!scope.task.taskId) {
                return `line ${scope.task.lineNumber + 1} has no parseable task id`;
            }

            for (const dependency of scope.task.dependencies ?? []) {
                if (dependency === scope.task.taskId) {
                    return `line ${scope.task.lineNumber + 1} depends on itself`;
                }

                if (!taskStatusesById.has(dependency)) {
                    return `line ${scope.task.lineNumber + 1} depends on unknown task ${dependency}`;
                }

                if (!runnableTaskIds.has(dependency) && taskStatusesById.get(dependency) !== 'completed') {
                    return `line ${scope.task.lineNumber + 1} depends on non-runnable incomplete task ${dependency}`;
                }
            }

            dependenciesByTaskId.set(
                scope.task.taskId,
                (scope.task.dependencies ?? []).filter(dependency => runnableTaskIds.has(dependency))
            );
        }

        const visit = (taskId: string): boolean => {
            if (visiting.has(taskId)) {
                return false;
            }

            if (visited.has(taskId)) {
                return true;
            }

            visiting.add(taskId);
            for (const dependency of dependenciesByTaskId.get(taskId) ?? []) {
                if (!visit(dependency)) {
                    return false;
                }
            }

            visiting.delete(taskId);
            visited.add(taskId);
            return true;
        };

        for (const taskId of dependenciesByTaskId.keys()) {
            if (!visit(taskId)) {
                return 'task dependencies contain a cycle';
            }
        }

        return undefined;
    }

    private getTaskScopeText(task: RunnableTask): string {
        return [task.description, ...task.detailLines].join('\n');
    }

    private extractReferencedFileScopes(text: string): string[] {
        const scopes = new Map<string, string>();
        const addCandidate = (candidate: string | undefined) => {
            if (!candidate) {
                return;
            }

            const normalized = this.normalizeFileScope(candidate);
            if (!normalized || !this.isFileScopeCandidate(normalized)) {
                return;
            }

            scopes.set(normalized.toLowerCase(), normalized);
        };

        let match: RegExpExecArray | null;
        const inlineCodePattern = /`([^`]+)`/g;
        while ((match = inlineCodePattern.exec(text)) !== null) {
            addCandidate(match[1]);
        }

        const barePathPattern = /(^|[\s([{"'])((?:\.{0,2}[\\/])?(?:(?:src|tests?|lib|media|icons|scripts|resources|prompts|dist|out|\.autocode|\.vscode)[\\/][^\s,;:)\]}]+|[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/:-]+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|yml|yaml|toml|py|cs|cpp|c|h|hpp|java|go|rs|vue|svelte|xml|svg)))/g;
        while ((match = barePathPattern.exec(text)) !== null) {
            addCandidate(match[2]);
        }

        return [...scopes.values()].sort((a, b) => a.localeCompare(b));
    }

    private normalizeFileScope(candidate: string): string | undefined {
        let value = candidate.trim();
        value = value.replace(/^[_*`]+/, '').replace(/[_*`]+$/, '');
        value = value.replace(/^["'([{]+/, '').replace(/["'.,;)\]}]+$/, '');
        value = value.replace(/^[_*`]+/, '').replace(/[_*`]+$/, '');
        value = value.replace(/:\d+(?::\d+)?$/, '');
        value = value.replace(/\\/g, '/').replace(/\/+/g, '/');
        value = value.replace(/^\.\//, '');

        if (!value || /^[a-z]+:\/\//i.test(value) || value.includes(' ')) {
            return undefined;
        }

        return path.normalize(value).replace(/\\/g, '/').replace(/^\.\//, '');
    }

    private isFileScopeCandidate(fileScope: string): boolean {
        if (/\.(ts|tsx|js|jsx|json|md|css|scss|html|yml|yaml|toml|py|cs|cpp|c|h|hpp|java|go|rs|vue|svelte|xml|svg)$/i.test(fileScope)) {
            return true;
        }

        return /^(src|tests?|lib|media|icons|scripts|resources|prompts|dist|out|\.autocode|\.vscode)\//i.test(fileScope);
    }

    private isSharedConflictScope(fileScope: string): boolean {
        const normalized = fileScope.toLowerCase();
        const baseName = path.posix.basename(normalized);

        if (/^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/.test(baseName)) {
            return true;
        }

        if (/^(tsconfig.*\.json|webpack\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s)$/.test(baseName)) {
            return true;
        }

        return normalized === 'tasks.md' ||
            normalized.endsWith('/tasks.md') ||
            normalized.startsWith('.autocode/') ||
            normalized.startsWith('.vscode/');
    }

    private getBroadParallelRisk(task: RunnableTask): string | undefined {
        const text = this.getTaskScopeText(task)
            .split(/\r?\n/)
            .filter(line => !this.isDependencyMetadataLine(line.trim()))
            .join('\n');
        const englishRisk = text.match(/\b(all|global|shared|cross-cutting|refactor|rename|move|install|package|configuration|config|build|generated|migration)\b/i);
        if (englishRisk) {
            return englishRisk[1];
        }

        const chineseRisk = text.match(/全局|共享|公共|重构|依赖|安装|配置|构建|生成|迁移|改名|移动/);
        return chineseRisk?.[0];
    }

    private isDependencyMetadataLine(line: string): boolean {
        return /^(?:[-*]\s*)?(?:_)?(?:depends on|dependencies|depends|blocked by|依赖|前置任务|依赖任务)\s*[:：]/i.test(line);
    }

    private findOverlappingFileScope(leftScopes: string[], rightScopes: string[]): string | undefined {
        for (const left of leftScopes) {
            for (const right of rightScopes) {
                if (this.fileScopesOverlap(left, right)) {
                    return left === right ? left : `${left} / ${right}`;
                }
            }
        }

        return undefined;
    }

    private fileScopesOverlap(left: string, right: string): boolean {
        const normalizedLeft = left.toLowerCase();
        const normalizedRight = right.toLowerCase();

        return normalizedLeft === normalizedRight ||
            normalizedLeft.startsWith(`${normalizedRight}/`) ||
            normalizedRight.startsWith(`${normalizedLeft}/`);
    }

    private getProviderTaskExecutionGuidance(): string {
        if (this.agentRuntime.provider.id === 'codex') {
            return [
                'Codex quality and speed rules:',
                '- Inspect the current worktree and the smallest relevant set of files before editing; avoid broad repository scans when targeted search is enough.',
                '- Keep edits scoped to the requested task and preserve unrelated user changes.',
                '- Prefer existing project helpers, scripts, and test patterns instead of introducing new abstractions.',
                '- Keep progress updates concise so more time is spent on code and verification.',
                '- Run the narrowest useful verification command after the implementation, then broaden only when the change risk justifies it.',
                '- Write the completion signal only after implementation and verification are complete.',
                '- If verification fails, fix the cause or report the blocker; do not signal completion for failed work.'
            ].join('\n');
        }

        return [
            'Keep changes scoped to the requested task.',
            'Use existing project patterns and run focused verification before signaling completion.'
        ].join('\n');
    }

    private getParallelTaskExecutionGuidance(fileScopes?: string[]): string {
        if (!fileScopes || fileScopes.length === 0) {
            return '';
        }

        return [
            'Parallel execution safety rules:',
            '- This task was launched alongside other spec tasks after static file-scope analysis.',
            `- Treat these paths as the allowed write scope for this task: ${fileScopes.join(', ')}.`,
            '- Do not edit files outside that scope. If the task requires another file, stop and report the conflict instead of continuing.',
            '- Do not write the completion signal until the task is complete within that scope and verification has passed.'
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
            'This file is mandatory for AutoCode automation. If you only summarize completion without writing this file, automatic verification and task status updates cannot run.',
            'Create the parent directory if needed, then write exactly this JSON object after your own implementation checks pass.',
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
            const uniqueMarker = `<!-- autocode-spec: ${specName}/${type} -->`;

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
