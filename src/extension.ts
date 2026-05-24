import * as vscode from 'vscode';
import * as path from 'path';
import { SpecManager } from './features/spec/specManager';
import { SteeringManager } from './features/steering/steeringManager';
import { SpecExplorerProvider } from './providers/specExplorerProvider';
import { SteeringExplorerProvider } from './providers/steeringExplorerProvider';
import { HooksExplorerProvider } from './providers/hooksExplorerProvider';
import { MCPExplorerProvider } from './providers/mcpExplorerProvider';
import { OverviewProvider } from './providers/overviewProvider';
import { AgentsExplorerProvider } from './providers/agentsExplorerProvider';
import { AgentManager } from './features/agents/agentManager';
import { ConfigManager } from './utils/configManager';
import { CONFIG_FILE_NAME, DEFAULT_PATHS, VSC_CONFIG_NAMESPACE } from './constants';
import { PromptLoader } from './services/promptLoader';
import { UpdateChecker } from './utils/updateChecker';
import { PermissionManager } from './features/permission/permissionManager';
import { NotificationUtils } from './utils/notificationUtils';
import { SpecTaskCodeLensProvider } from './providers/specTaskCodeLensProvider';
import { AgentRuntime } from './runtime/agentRuntime';
import { TerminalAgentRuntime } from './runtime/terminalAgentRuntime';
import { buildSpecTaskStatusUpdates, hasChildSpecTasks, parseSpecTaskLine, replaceSpecTaskStatus, SpecTaskStatus } from './features/spec/taskStatus';
import { TaskSessionManager } from './features/spec/taskSessionManager';
import { TaskCompletionVerifier } from './features/spec/taskCompletionVerifier';

let agentRuntime: AgentRuntime;
let specManager: SpecManager;
let steeringManager: SteeringManager;
let permissionManager: PermissionManager;
let agentManager: AgentManager;
let taskSessionManager: TaskSessionManager;
let taskCompletionVerifier: TaskCompletionVerifier;
export let outputChannel: vscode.OutputChannel;

// 导出 getter 函数供其他模块使用
export function getPermissionManager(): PermissionManager {
    return permissionManager;
}

export async function activate(context: vscode.ExtensionContext) {
    // Create output channel for debugging
    outputChannel = vscode.window.createOutputChannel('AutoCode - Debug');

    // Initialize PromptLoader
    try {
        const promptLoader = PromptLoader.getInstance();
        promptLoader.initialize();
        outputChannel.appendLine('PromptLoader initialized successfully');
    } catch (error) {
        outputChannel.appendLine(`Failed to initialize PromptLoader: ${error}`);
        vscode.window.showErrorMessage(`Failed to initialize prompt system: ${error}`);
    }

    // 检查工作区状态
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        outputChannel.appendLine('WARNING: No workspace folder found!');
    }


    const configManager = ConfigManager.getInstance();
    await configManager.loadSettings();

    // Initialize agent runtime with output channel
    agentRuntime = new TerminalAgentRuntime(context, outputChannel);

    // 创建并初始化 PermissionManager
    permissionManager = new PermissionManager(context, outputChannel);

    // 初始化权限系统（包含重试逻辑）
    if (agentRuntime.provider.capabilities.permissions) {
        await permissionManager.initializePermissions();
    } else {
        outputChannel.appendLine(`[AgentRuntime] Skipping Claude permission setup for ${agentRuntime.provider.displayName}`);
    }

    // Initialize feature managers with output channel
    taskSessionManager = new TaskSessionManager(outputChannel);
    taskCompletionVerifier = new TaskCompletionVerifier(agentRuntime, taskSessionManager, outputChannel);
    specManager = new SpecManager(agentRuntime, outputChannel, taskSessionManager);
    steeringManager = new SteeringManager(agentRuntime, outputChannel);

    // Initialize Agent Manager and agents
    agentManager = new AgentManager(context, outputChannel);
    await agentManager.initializeBuiltInAgents();

    // Register tree data providers
    const overviewProvider = new OverviewProvider(context);
    const specExplorer = new SpecExplorerProvider(context, outputChannel);
    const steeringExplorer = new SteeringExplorerProvider(context);
    const hooksExplorer = new HooksExplorerProvider(context, agentRuntime.provider);
    const mcpExplorer = new MCPExplorerProvider(context, outputChannel);
    const agentsExplorer = new AgentsExplorerProvider(context, agentManager, outputChannel, agentRuntime.provider);

    // Set managers
    specExplorer.setSpecManager(specManager);
    steeringExplorer.setSteeringManager(steeringManager);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('autocode.views.overview', overviewProvider),
        vscode.window.registerTreeDataProvider('autocode.views.specExplorer', specExplorer),
        vscode.window.registerTreeDataProvider('autocode.views.agentsExplorer', agentsExplorer),
        vscode.window.registerTreeDataProvider('autocode.views.steeringExplorer', steeringExplorer),
        vscode.window.registerTreeDataProvider('autocode.views.hooksStatus', hooksExplorer),
        vscode.window.registerTreeDataProvider('autocode.views.mcpServerStatus', mcpExplorer)
    );

    // Initialize update checker
    const updateChecker = new UpdateChecker(context, outputChannel);

    // Register commands
    registerCommands(context, specExplorer, steeringExplorer, hooksExplorer, mcpExplorer, agentsExplorer, updateChecker);

    // Initialize default settings file if not exists
    await initializeDefaultSettings();

    // Set up file watchers
    setupFileWatchers(context, specExplorer, steeringExplorer, hooksExplorer, mcpExplorer, agentsExplorer);

    // Check for updates on startup
    updateChecker.checkForUpdates();
    outputChannel.appendLine('Update check initiated');

    const specTaskCodeLensProvider = new SpecTaskCodeLensProvider();

    let specDir: string = DEFAULT_PATHS.specs;
    try {
        await configManager.loadSettings();
        const configuredSpecDir = configManager.getPath('specs');
        specDir = configuredSpecDir || specDir;
    } catch (error) {
        outputChannel.appendLine(`Failed to load settings for spec CodeLens: ${error}`);
    }

    // // Register CodeLens provider for spec tasks once settings are ready
    // const specTaskCodeLensProvider = new SpecTaskCodeLensProvider();

    const normalizedSpecDir = specDir.replace(/\\/g, '/');

    // 使用更明确的文档选择器
    const selector: vscode.DocumentSelector = [
        {
            language: 'markdown',
            pattern: `**/${normalizedSpecDir}/*/tasks.md`,
            scheme: 'file'
        }
    ];

    const disposable = vscode.languages.registerCodeLensProvider(
        selector,
        specTaskCodeLensProvider
    );

    context.subscriptions.push(disposable);

    outputChannel.appendLine('CodeLens provider for spec tasks registered');
}

async function initializeDefaultSettings() {
    await ensureSettingsFile();
}

async function ensureSettingsFile(): Promise<vscode.Uri | undefined> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return undefined;
    }

    const autocodeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.autocode');
    const settingsDir = vscode.Uri.joinPath(workspaceFolder.uri, ...DEFAULT_PATHS.settings.split('/'));

    try {
        await vscode.workspace.fs.createDirectory(autocodeDir);
        await vscode.workspace.fs.createDirectory(settingsDir);
    } catch (error) {
        // Directory might already exist
    }

    const settingsFile = vscode.Uri.joinPath(settingsDir, CONFIG_FILE_NAME);
    const configManager = ConfigManager.getInstance();

    try {
        await vscode.workspace.fs.stat(settingsFile);
    } catch (error) {
        await configManager.loadSettings();
        await configManager.saveSettings(configManager.getSettings());
        return settingsFile;
    }

    try {
        const fileContent = await vscode.workspace.fs.readFile(settingsFile);
        JSON.parse(Buffer.from(fileContent).toString());
        await configManager.loadSettings();
        await configManager.saveSettings(configManager.getSettings());
    } catch (error) {
        outputChannel?.appendLine(`[Settings] Existing settings file is not valid JSON: ${error}`);
    }

    return settingsFile;
}

async function toggleViews() {
    const config = vscode.workspace.getConfiguration(VSC_CONFIG_NAMESPACE);
    const currentVisibility = {
        specs: config.get('views.specs.visible', true),
        agents: config.get('views.agents.visible', true),
        hooks: config.get('views.hooks.visible', true),
        steering: config.get('views.steering.visible', true),
        mcp: config.get('views.mcp.visible', true)
    };

    const items = [
        {
            label: `$(${currentVisibility.specs ? 'check' : 'blank'}) Specs`,
            picked: currentVisibility.specs,
            id: 'specs'
        },
        {
            label: `$(${currentVisibility.agents ? 'check' : 'blank'}) Agents`,
            picked: currentVisibility.agents,
            id: 'agents'
        },
        {
            label: `$(${currentVisibility.hooks ? 'check' : 'blank'}) Agent Hooks`,
            picked: currentVisibility.hooks,
            id: 'hooks'
        },
        {
            label: `$(${currentVisibility.steering ? 'check' : 'blank'}) Agent Steering`,
            picked: currentVisibility.steering,
            id: 'steering'
        },
        {
            label: `$(${currentVisibility.mcp ? 'check' : 'blank'}) MCP Servers`,
            picked: currentVisibility.mcp,
            id: 'mcp'
        }
    ];

    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select views to show'
    });

    if (selected) {
        const newVisibility = {
            specs: selected.some(item => item.id === 'specs'),
            agents: selected.some(item => item.id === 'agents'),
            hooks: selected.some(item => item.id === 'hooks'),
            steering: selected.some(item => item.id === 'steering'),
            mcp: selected.some(item => item.id === 'mcp')
        };

        await config.update('views.specs.visible', newVisibility.specs, vscode.ConfigurationTarget.Workspace);
        await config.update('views.agents.visible', newVisibility.agents, vscode.ConfigurationTarget.Workspace);
        await config.update('views.hooks.visible', newVisibility.hooks, vscode.ConfigurationTarget.Workspace);
        await config.update('views.steering.visible', newVisibility.steering, vscode.ConfigurationTarget.Workspace);
        await config.update('views.mcp.visible', newVisibility.mcp, vscode.ConfigurationTarget.Workspace);

        const configManager = ConfigManager.getInstance();
        const settings = configManager.getSettings();
        await configManager.saveSettings({
            ...settings,
            views: {
                ...settings.views,
                specs: { visible: newVisibility.specs },
                agents: { visible: newVisibility.agents },
                hooks: { visible: newVisibility.hooks },
                steering: { visible: newVisibility.steering },
                mcp: { visible: newVisibility.mcp }
            }
        });

        vscode.window.showInformationMessage('View visibility updated!');
    }
}


function registerCommands(context: vscode.ExtensionContext, specExplorer: SpecExplorerProvider, steeringExplorer: SteeringExplorerProvider, hooksExplorer: HooksExplorerProvider, mcpExplorer: MCPExplorerProvider, agentsExplorer: AgentsExplorerProvider, updateChecker: UpdateChecker) {

    // Permission commands
    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.permission.reset', async () => {
            await agentRuntime.refreshProvider?.();

            if (!agentRuntime.provider.capabilities.permissions) {
                vscode.window.showInformationMessage(`Permissions are not required for ${agentRuntime.provider.displayName}.`);
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                'Are you sure you want to reset Claude Code permissions? This will revoke the granted permissions.',
                'Yes', 'No'
            );

            if (confirm === 'Yes') {
                const success = await permissionManager.resetPermission();
                if (success) {
                    NotificationUtils.showAutoDismissNotification(
                        'Permissions have been reset'
                    );
                } else {
                    vscode.window.showErrorMessage('Failed to reset permissions. Please check the output log.');
                }
            }
        })
    );

    // Spec commands
    const createSpecCommand = vscode.commands.registerCommand('autocode.spec.create', async () => {
        outputChannel.appendLine('\n=== COMMAND autocode.spec.create TRIGGERED ===');
        outputChannel.appendLine(`Time: ${new Date().toLocaleTimeString()}`);

        try {
            await specManager.create();
        } catch (error) {
            outputChannel.appendLine(`Error in createNewSpec: ${error}`);
            vscode.window.showErrorMessage(`Failed to create spec: ${error}`);
        }
    });

    const createSpecWithAgentsCommand = vscode.commands.registerCommand('autocode.spec.createWithAgents', async () => {
        try {
            await specManager.createWithAgents();
        } catch (error) {
            outputChannel.appendLine(`Error in createWithAgents: ${error}`);
            vscode.window.showErrorMessage(`Failed to create spec with agents: ${error}`);
        }
    });

    context.subscriptions.push(createSpecCommand, createSpecWithAgentsCommand);

    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.spec.navigate.requirements', async (specName: string) => {
            await specManager.navigateToDocument(specName, 'requirements');
        }),

        vscode.commands.registerCommand('autocode.spec.navigate.design', async (specName: string) => {
            await specManager.navigateToDocument(specName, 'design');
        }),

        vscode.commands.registerCommand('autocode.spec.navigate.tasks', async (specName: string) => {
            await specManager.navigateToDocument(specName, 'tasks');
        }),

        vscode.commands.registerCommand('autocode.spec.implTask', async (documentUri: vscode.Uri, lineNumber: number, taskDescription: string, resume = false) => {
            outputChannel.appendLine(`[Task Execute] Line ${lineNumber + 1}: ${taskDescription}`);

            const result = await updateTaskLineStatus(documentUri, lineNumber, 'inProgress');
            const task = result?.task;
            if (task?.status === 'completed') {
                vscode.window.showInformationMessage(`Task is already completed: ${task.description}`);
                return;
            }

            const effectiveDescription = task?.description || taskDescription;
            const shouldResume = resume || task?.status === 'inProgress';

            const run = await specManager.implTask(documentUri.fsPath, effectiveDescription, shouldResume, lineNumber);
            if (run?.terminal) {
                registerAutoTaskCompletion(context, run.terminal, documentUri.fsPath, lineNumber, effectiveDescription, run.completionSignalPath);
            }
        }),
        vscode.commands.registerCommand('autocode.spec.implAllTasks', async (documentUri: vscode.Uri) => {
            outputChannel.appendLine(`[Task Execute] Starting all tasks: ${documentUri.fsPath}`);

            const run = await specManager.implAllTasks(documentUri.fsPath);
            if (run?.terminal && run.completionSignalPaths) {
                await markRunnableTasksInProgress(documentUri);
                registerAutoTaskCompletionSignals(context, run.terminal, documentUri.fsPath, run.completionSignalPaths);
            }
        }),
        vscode.commands.registerCommand('autocode.spec.markTaskDone', async (documentUri: vscode.Uri, lineNumber: number) => {
            outputChannel.appendLine(`[Task Complete] Line ${lineNumber + 1}`);

            const result = await updateTaskLineStatus(documentUri, lineNumber, 'completed');
            const task = result?.task;
            if (!task) {
                vscode.window.showWarningMessage('Could not find a task checkbox on the selected line.');
                return;
            }

            await taskSessionManager.markCompleted(documentUri.fsPath, lineNumber, task.description);
            for (const parent of result.parentTasks) {
                await taskSessionManager.markCompleted(documentUri.fsPath, parent.lineNumber, parent.description);
            }
            vscode.window.showInformationMessage(`Task marked done: ${task.description}`);
        }),
        vscode.commands.registerCommand('autocode.spec.viewTaskSession', async (documentUri: vscode.Uri, lineNumber: number, taskDescription?: string) => {
            outputChannel.appendLine(`[Task Session] Line ${lineNumber + 1}`);

            const task = await readTaskLine(documentUri, lineNumber);
            const effectiveDescription = task?.description || taskDescription;
            if (!effectiveDescription) {
                vscode.window.showWarningMessage('Could not find a task checkbox on the selected line.');
                return;
            }

            await taskSessionManager.showSession(documentUri.fsPath, lineNumber, effectiveDescription);
        }),
        vscode.commands.registerCommand('autocode.spec.refresh', async () => {
            outputChannel.appendLine('[Manual Refresh] Refreshing spec explorer...');
            specExplorer.refresh();
        })
    );

    // Steering commands
    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.steering.create', async () => {
            await steeringManager.createCustom();
        }),

        vscode.commands.registerCommand('autocode.steering.generateInitial', async () => {
            await steeringManager.init();
        }),

        vscode.commands.registerCommand('autocode.steering.refine', async (item: any) => {
            // Item is always from tree view
            const uri = vscode.Uri.file(item.resourcePath);
            await steeringManager.refine(uri);
        }),

        vscode.commands.registerCommand('autocode.steering.delete', async (item: any) => {
            outputChannel.appendLine(`[Steering] Deleting: ${item.label}`);

            // Use SteeringManager to delete the document and update CLAUDE.md
            const result = await steeringManager.delete(item.label, item.resourcePath);

            if (!result.success && result.error) {
                vscode.window.showErrorMessage(result.error);
            }
        }),

        // CLAUDE.md commands
        vscode.commands.registerCommand('autocode.steering.createUserRule', async () => {
            await steeringManager.createUserClaudeMd();
        }),

        vscode.commands.registerCommand('autocode.steering.createProjectRule', async () => {
            await steeringManager.createProjectClaudeMd();
        }),

        vscode.commands.registerCommand('autocode.steering.refresh', async () => {
            outputChannel.appendLine('[Manual Refresh] Refreshing steering explorer...');
            steeringExplorer.refresh();
        }),

        // Agents commands
        vscode.commands.registerCommand('autocode.agents.refresh', async () => {
            outputChannel.appendLine('[Manual Refresh] Refreshing agents explorer...');
            agentsExplorer.refresh();
        })
    );

    // Add file save confirmation for agent files
    context.subscriptions.push(
        vscode.workspace.onWillSaveTextDocument(async (event) => {
            const document = event.document;
            const filePath = document.fileName;

            // Check if this is an agent file
            if (filePath.includes('.autocode/agents/') && filePath.endsWith('.md')) {
                // Show confirmation dialog
                const result = await vscode.window.showWarningMessage(
                    'Are you sure you want to save changes to this agent file?',
                    { modal: true },
                    'Save',
                    'Cancel'
                );

                if (result !== 'Save') {
                    // Cancel the save operation by waiting forever
                    event.waitUntil(new Promise(() => { }));
                }
            }
        })
    );

    // Spec delete command
    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.spec.delete', async (item: any) => {
            await specManager.delete(item.label);
        })
    );

    // Agent integration commands
    // (removed unused autocode.claude.implementTask command)

    // Hooks commands (only refresh for Claude Code hooks)
    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.hooks.refresh', () => {
            hooksExplorer.refresh();
        }),

        vscode.commands.registerCommand('autocode.hooks.copyCommand', async (command: string) => {
            await vscode.env.clipboard.writeText(command);
        })
    );

    // MCP commands
    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.mcp.refresh', () => {
            mcpExplorer.refresh();
        }),

        // Update checker command
        vscode.commands.registerCommand('autocode.checkForUpdates', async () => {
            outputChannel.appendLine('Manual update check requested');
            await updateChecker.checkForUpdates(true); // Force check
        }),

        // Overview and settings commands
        vscode.commands.registerCommand('autocode.settings.open', async () => {
            outputChannel.appendLine('Opening AutoCode settings...');

            const settingsFile = await ensureSettingsFile();
            if (!settingsFile) {
                vscode.window.showErrorMessage('No workspace folder found');
                return;
            }

            // Open the settings file
            const document = await vscode.workspace.openTextDocument(settingsFile);
            await vscode.window.showTextDocument(document);
        }),

        vscode.commands.registerCommand('autocode.help.open', async () => {
            outputChannel.appendLine('Opening AutoCode help...');
            const helpUrl = 'https://github.com/Coden198524/autocode#readme';
            vscode.env.openExternal(vscode.Uri.parse(helpUrl));
        }),

        vscode.commands.registerCommand('autocode.menu.open', async () => {
            outputChannel.appendLine('Opening AutoCode menu...');
            await toggleViews();
        }),

        // Permission debug commands
        vscode.commands.registerCommand('autocode.permission.check', async () => {
            await agentRuntime.refreshProvider?.();

            if (!agentRuntime.provider.capabilities.permissions) {
                vscode.window.showInformationMessage(`Permissions are not required for ${agentRuntime.provider.displayName}.`);
                return;
            }

            const hasPermission = await permissionManager.checkPermission();
            const configPath = require('os').homedir() + '/.claude.json';

            vscode.window.showInformationMessage(
                `Claude Code Permission Status: ${hasPermission ? 'Granted' : 'Not Granted'}`
            );

            outputChannel.appendLine(`[Permission Check] Status: ${hasPermission}`);
            outputChannel.appendLine(`[Permission Check] Config file: ${configPath}`);
            outputChannel.appendLine(`[Permission Check] Checking bypassPermissionsModeAccepted field in ~/.claude.json`);
        }),

    );
}

async function updateTaskLineStatus(documentUri: vscode.Uri, lineNumber: number, status: SpecTaskStatus) {
    const document = await vscode.workspace.openTextDocument(documentUri);
    const line = document.lineAt(lineNumber);
    const task = parseSpecTaskLine(line.text);
    if (!task) {
        return undefined;
    }

    if (task.status === 'completed' && status !== 'completed') {
        return { task, parentTasks: [] };
    }

    const updates = status === 'completed'
        ? buildSpecTaskStatusUpdates(getDocumentLines(document), lineNumber, status)
        : buildSingleTaskStatusUpdate(line.text, lineNumber, status);
    if (updates.length === 0) {
        return { task, parentTasks: [] };
    }

    const edit = new vscode.WorkspaceEdit();
    for (const update of updates) {
        edit.replace(documentUri, new vscode.Range(update.lineNumber, 0, update.lineNumber, update.oldText.length), update.newText);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
        await document.save();
    }

    return {
        task,
        parentTasks: updates
            .filter(update => update.lineNumber !== lineNumber)
            .map(update => ({
                lineNumber: update.lineNumber,
                description: update.task.description
            }))
    };
}

async function markRunnableTasksInProgress(documentUri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(documentUri);
    const lines = getDocumentLines(document);
    const edit = new vscode.WorkspaceEdit();
    let changed = false;

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
        const line = document.lineAt(lineNumber);
        const task = parseSpecTaskLine(line.text);
        if (!task || task.status !== 'pending') {
            continue;
        }

        if (hasChildSpecTasks(lines, lineNumber)) {
            continue;
        }

        const newLine = replaceSpecTaskStatus(line.text, 'inProgress');
        if (!newLine || newLine === line.text) {
            continue;
        }

        edit.replace(documentUri, new vscode.Range(lineNumber, 0, lineNumber, line.text.length), newLine);
        changed = true;
    }

    if (!changed) {
        return;
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
        await document.save();
    }
}

async function readTaskLine(documentUri: vscode.Uri, lineNumber: number) {
    const document = await vscode.workspace.openTextDocument(documentUri);
    return parseSpecTaskLine(document.lineAt(lineNumber).text);
}

function getDocumentLines(document: vscode.TextDocument): string[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        lines.push(document.lineAt(i).text);
    }
    return lines;
}

function buildSingleTaskStatusUpdate(lineText: string, lineNumber: number, status: SpecTaskStatus) {
    const task = parseSpecTaskLine(lineText);
    const newText = replaceSpecTaskStatus(lineText, status);
    if (!task || !newText || newText === lineText) {
        return [];
    }

    return [{
        lineNumber,
        oldText: lineText,
        newText,
        task
    }];
}

function registerAutoTaskCompletion(
    context: vscode.ExtensionContext,
    terminal: vscode.Terminal,
    taskFilePath: string,
    lineNumber: number,
    taskDescription: string,
    completionSignalPath?: string
) {
    if (!taskCompletionVerifier.isEnabled()) {
        return;
    }

    let handled = false;
    const runVerification = async () => {
        if (handled) {
            return;
        }

        handled = true;
        closeDisposable.dispose();
        shellEndDisposable.dispose();
        signalDisposable?.dispose();

        await taskCompletionVerifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber,
            taskDescription
        });
    };

    const shellEndDisposable = vscode.window.onDidEndTerminalShellExecution(async (event) => {
        if (event.terminal !== terminal) {
            return;
        }

        await runVerification();
    });

    const disposable = vscode.window.onDidCloseTerminal(async (closedTerminal) => {
        if (closedTerminal !== terminal) {
            return;
        }

        await runVerification();
    });

    const closeDisposable = disposable;
    const signalDisposable = completionSignalPath
        ? registerTaskCompletionSignalWatcher(completionSignalPath, runVerification)
        : undefined;
    context.subscriptions.push(...[closeDisposable, shellEndDisposable, signalDisposable].filter((item): item is vscode.Disposable => Boolean(item)));
}

function registerAutoTaskCompletionSignals(
    context: vscode.ExtensionContext,
    terminal: vscode.Terminal,
    taskFilePath: string,
    completionSignalPaths: string[]
) {
    if (!taskCompletionVerifier.isEnabled()) {
        return;
    }

    const disposables: vscode.Disposable[] = [];
    const completedSignals = new Set<string>();

    const verifySignal = async (completionSignalPath: string) => {
        if (completedSignals.has(completionSignalPath)) {
            return;
        }

        completedSignals.add(completionSignalPath);
        const lineNumber = parseCompletionSignalLineNumber(completionSignalPath);
        if (lineNumber === undefined) {
            outputChannel.appendLine(`[Task Complete] Could not infer task line from signal path: ${completionSignalPath}`);
            return;
        }

        const task = await readTaskLine(vscode.Uri.file(taskFilePath), lineNumber);
        if (!task) {
            outputChannel.appendLine(`[Task Complete] Could not read task line ${lineNumber + 1} for signal: ${completionSignalPath}`);
            return;
        }

        await taskCompletionVerifier.verifyAndMarkDone({
            taskFilePath,
            lineNumber,
            taskDescription: task.description
        });
    };

    for (const signalPath of completionSignalPaths) {
        disposables.push(registerTaskCompletionSignalWatcher(signalPath, () => verifySignal(signalPath)));
    }

    const terminalDisposable = vscode.window.onDidCloseTerminal(closedTerminal => {
        if (closedTerminal !== terminal) {
            return;
        }

        disposables.forEach(disposable => disposable.dispose());
        terminalDisposable.dispose();
    });

    context.subscriptions.push(...disposables, terminalDisposable);
}

function parseCompletionSignalLineNumber(completionSignalPath: string): number | undefined {
    const match = path.basename(completionSignalPath).match(/^task-completion-(\d+)\.json$/);
    if (!match) {
        return undefined;
    }

    return Number(match[1]) - 1;
}

function registerTaskCompletionSignalWatcher(completionSignalPath: string, onSignal: () => Promise<void>): vscode.Disposable {
    const signalUri = vscode.Uri.file(completionSignalPath);
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(path.dirname(signalUri.fsPath), path.basename(signalUri.fsPath))
    );
    let timer: NodeJS.Timeout | undefined;

    const trigger = (uri: vscode.Uri) => {
        if (uri.fsPath !== signalUri.fsPath) {
            return;
        }

        outputChannel.appendLine(`[Task Complete] Completion signal detected: ${uri.fsPath}`);

        if (timer) {
            clearTimeout(timer);
        }

        timer = setTimeout(() => {
            onSignal().catch(error => {
                outputChannel.appendLine(`[Task Complete] Failed to verify completion signal: ${error}`);
            });
        }, 500);
    };

    watcher.onDidCreate(trigger);
    watcher.onDidChange(trigger);

    return {
        dispose: () => {
            if (timer) {
                clearTimeout(timer);
            }
            watcher.dispose();
        }
    };
}

function setupFileWatchers(
    context: vscode.ExtensionContext,
    specExplorer: SpecExplorerProvider,
    steeringExplorer: SteeringExplorerProvider,
    hooksExplorer: HooksExplorerProvider,
    mcpExplorer: MCPExplorerProvider,
    agentsExplorer: AgentsExplorerProvider
) {
    // Watch for changes in the AutoCode project directory with debouncing
    const autocodeWatcher = vscode.workspace.createFileSystemWatcher('**/.autocode/**/*');

    let refreshTimeout: NodeJS.Timeout | undefined;
    const debouncedRefresh = (event: string, uri: vscode.Uri) => {
        outputChannel.appendLine(`[FileWatcher] ${event}: ${uri.fsPath}`);

        if (refreshTimeout) {
            clearTimeout(refreshTimeout);
        }
        refreshTimeout = setTimeout(async () => {
            await ConfigManager.getInstance().loadSettings();
            await agentRuntime.refreshProvider?.();
            specExplorer.refresh();
            steeringExplorer.refresh();
            hooksExplorer.refresh();
            mcpExplorer.refresh();
            agentsExplorer.refresh();
        }, 1000); // Increase debounce time to 1 second
    };

    autocodeWatcher.onDidCreate((uri) => debouncedRefresh('Create', uri));
    autocodeWatcher.onDidDelete((uri) => debouncedRefresh('Delete', uri));
    autocodeWatcher.onDidChange((uri) => debouncedRefresh('Change', uri));

    context.subscriptions.push(autocodeWatcher);

    // Watch for changes in Claude settings
    const claudeSettingsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(process.env.HOME || '', '.claude/settings.json')
    );

    claudeSettingsWatcher.onDidChange(() => {
        hooksExplorer.refresh();
        mcpExplorer.refresh();
    });

    context.subscriptions.push(claudeSettingsWatcher);

    // Watch for changes in CLAUDE.md files
    const globalClaudeMdWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(process.env.HOME || '', '.claude/CLAUDE.md')
    );
    const projectClaudeMdWatcher = vscode.workspace.createFileSystemWatcher('**/CLAUDE.md');

    globalClaudeMdWatcher.onDidCreate(() => steeringExplorer.refresh());
    globalClaudeMdWatcher.onDidDelete(() => steeringExplorer.refresh());
    projectClaudeMdWatcher.onDidCreate(() => steeringExplorer.refresh());
    projectClaudeMdWatcher.onDidDelete(() => steeringExplorer.refresh());

    context.subscriptions.push(globalClaudeMdWatcher, projectClaudeMdWatcher);
}

export function deactivate() {
    // Cleanup
    if (permissionManager) {
        permissionManager.dispose();
    }
}
