import * as vscode from 'vscode';
import { SpecManager } from './features/spec/specManager';
import { SteeringManager } from './features/steering/steeringManager';
import { SpecExplorerProvider } from './providers/specExplorerProvider';
import { SteeringExplorerProvider } from './providers/steeringExplorerProvider';
import { HooksExplorerProvider } from './providers/hooksExplorerProvider';
import { MCPExplorerProvider } from './providers/mcpExplorerProvider';
import { OverviewProvider } from './providers/overviewProvider';
import { AgentsExplorerProvider } from './providers/agentsExplorerProvider';
import { MemoryExplorerProvider } from './providers/memoryExplorerProvider';
import { AgentManager } from './features/agents/agentManager';
import { MemoryManager } from './features/memory/memoryManager';
import { ConfigManager } from './utils/configManager';
import { PromptLoader } from './services/promptLoader';
import { UpdateChecker } from './utils/updateChecker';
import { PermissionManager } from './features/permission/permissionManager';
import { AgentRuntime } from './runtime/agentRuntime';
import { TerminalAgentRuntime } from './runtime/terminalAgentRuntime';
import { TaskSessionManager } from './features/spec/taskSessionManager';
import { TaskCompletionVerifier } from './features/spec/taskCompletionVerifier';
import { TaskCompletionService } from './features/spec/taskCompletionService';
import { registerSpecCommands } from './commands/specCommands';
import { registerPermissionCommands } from './commands/permissionCommands';
import { registerSteeringCommands } from './commands/steeringCommands';
import { registerMemoryCommands } from './commands/memoryCommands';
import { registerGeneralCommands } from './commands/generalCommands';
import { registerWorkspaceWatchers } from './watchers/workspaceWatchers';
import { SettingsManager } from './features/settings/settingsManager';
import { registerSpecTaskCodeLens } from './providers/specTaskCodeLensRegistration';

let agentRuntime: AgentRuntime;
let specManager: SpecManager;
let steeringManager: SteeringManager;
let permissionManager: PermissionManager;
let agentManager: AgentManager;
let taskSessionManager: TaskSessionManager;
let taskCompletionVerifier: TaskCompletionVerifier;
let taskCompletionService: TaskCompletionService;
let settingsManager: SettingsManager;
let memoryManager: MemoryManager;
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
    settingsManager = new SettingsManager(outputChannel);
    memoryManager = new MemoryManager(context, outputChannel);
    taskSessionManager = new TaskSessionManager(outputChannel, undefined, memoryManager);
    taskCompletionVerifier = new TaskCompletionVerifier(agentRuntime, taskSessionManager, outputChannel, memoryManager);
    taskCompletionService = new TaskCompletionService(taskCompletionVerifier, outputChannel);
    // Initialize Agent Manager and agents
    agentManager = new AgentManager(context, outputChannel);
    steeringManager = new SteeringManager(agentRuntime, outputChannel);
    specManager = new SpecManager(agentRuntime, outputChannel, taskSessionManager, agentManager, () => steeringManager.init(), memoryManager);
    await agentManager.initializeBuiltInAgents();

    // Register tree data providers
    const overviewProvider = new OverviewProvider(context);
    const specExplorer = new SpecExplorerProvider(context, outputChannel);
    const steeringExplorer = new SteeringExplorerProvider(context);
    const memoryExplorer = new MemoryExplorerProvider(memoryManager);
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
        vscode.window.registerTreeDataProvider('autocode.views.memoryExplorer', memoryExplorer),
        vscode.window.registerTreeDataProvider('autocode.views.hooksStatus', hooksExplorer),
        vscode.window.registerTreeDataProvider('autocode.views.mcpServerStatus', mcpExplorer)
    );

    // Initialize update checker
    const updateChecker = new UpdateChecker(context, outputChannel);

    registerPermissionCommands({ context, agentRuntime, permissionManager, outputChannel });
    registerSpecCommands({
        context,
        specManager,
        specExplorer,
        taskSessionManager,
        taskCompletionService,
        outputChannel
    });
    registerSteeringCommands({
        context,
        steeringManager,
        steeringExplorer,
        agentsExplorer,
        agentManager,
        outputChannel
    });
    registerMemoryCommands({
        context,
        memoryManager,
        memoryExplorer,
        outputChannel
    });
    registerGeneralCommands({
        context,
        hooksExplorer,
        mcpExplorer,
        overviewProvider,
        updateChecker,
        settingsManager,
        outputChannel
    });

    // Initialize default settings file if not exists
    await settingsManager.initializeDefaultSettings();

    registerWorkspaceWatchers({
        context,
        agentRuntime,
        specExplorer,
        steeringExplorer,
        hooksExplorer,
        mcpExplorer,
        agentsExplorer,
        outputChannel
    });

    // Check for updates on startup
    updateChecker.checkForUpdates();
    outputChannel.appendLine('Update check initiated');

    await registerSpecTaskCodeLens(context, configManager, outputChannel);
}

export function deactivate() {
    // Cleanup
    if (permissionManager) {
        permissionManager.dispose();
    }
}
