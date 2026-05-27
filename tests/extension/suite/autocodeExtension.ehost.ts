import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { SpecManager } from '../../../src/features/spec/specManager';
import { PromptLoader } from '../../../src/services/promptLoader';
import {
    AgentInvocationRequest,
    AgentInvocationResult,
    AgentProviderConfig,
    AgentRuntime
} from '../../../src/runtime/agentRuntime';
import {
    readAutoTaskQueueRecord,
    TaskQueueController
} from '../../../src/features/spec/taskQueueController';
import { TaskCompletionService } from '../../../src/features/spec/taskCompletionService';
import { TaskCompletionVerifier } from '../../../src/features/spec/taskCompletionVerifier';
import { TaskQueueRecoveryInspector } from '../../../src/features/spec/taskQueueRecovery';

suite('AutoCode Extension Host Critical Paths', () => {
    let workspacePath: string;
    let outputChannel: vscode.OutputChannel;

    setup(async () => {
        workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        assert.ok(workspacePath, 'Extension host test workspace is required.');
        outputChannel = vscode.window.createOutputChannel('AutoCode Extension Host Tests');
        await fs.rm(path.join(workspacePath, '.autocode'), { recursive: true, force: true });
        await fs.mkdir(path.join(workspacePath, '.autocode', 'specs'), { recursive: true });
    });

    teardown(async () => {
        outputChannel.dispose();
        await fs.rm(path.join(workspacePath, '.autocode'), { recursive: true, force: true });
    });

    test('Create Spec renders a grounded prompt and invokes the active runtime', async () => {
        PromptLoader.getInstance().initialize();
        const runtime = new RecordingRuntime();
        const manager = new SpecManager(runtime, outputChannel);

        await (manager as any).createFromDescription('Add queue status visualization for StartAllTasks', false);
        await fs.mkdir(path.join(workspacePath, '.autocode', 'specs', 'queue-status-visualization'), { recursive: true });
        await wait(250);

        assert.strictEqual(runtime.requests.length, 1);
        assert.strictEqual(runtime.requests[0].agentType, 'spec_orchestrator');
        assert.match(runtime.requests[0].prompt, /Add queue status visualization for StartAllTasks/);
        assert.match(runtime.requests[0].prompt, /\.autocode[\\/]specs/);
    });

    test('StartAllTasks sequential continuation reconciles completion signal with real VS Code files', async () => {
        const taskFilePath = await writeSpec('sequential-queue', [
            '# Tasks',
            '- [-] 1. Implement queue state',
            '  - _Files: src/queue.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.1_',
            '  - _Verify: npm test -- queue.test.ts_',
            '  - _Done when: queue state is persisted_'
        ]);
        const documentUri = vscode.Uri.file(taskFilePath);
        const signalPath = path.join(path.dirname(taskFilePath), '.autocode', 'task-completion-2.json');
        const controller = new TaskQueueController(outputChannel);
        const service = new TaskCompletionService(new AlwaysPassVerifier() as unknown as TaskCompletionVerifier, outputChannel);

        await controller.start(documentUri, 'autocode.spec.implAllTasks');
        await controller.waitForTask(documentUri, 'autocode.spec.implAllTasks', {
            lineNumber: 1,
            taskDescription: '1. Implement queue state',
            completionSignalPath: signalPath,
            completionSignalToken: 'run-sequential-1'
        });
        await fs.mkdir(path.dirname(signalPath), { recursive: true });
        await fs.writeFile(signalPath, JSON.stringify({
            status: 'ready_for_verification',
            taskFilePath,
            lineNumber: 1,
            taskDescription: '1. Implement queue state',
            runId: 'run-sequential-1'
        }), 'utf8');

        const result = await service.reconcileTaskCompletionSignals(taskFilePath, {
            lineNumbers: [1],
            expectedRunIdsByLineNumber: { 1: 'run-sequential-1' }
        });
        const continuationCommand = await controller.consumeContinuation(documentUri, 1, 'extension host verification');

        assert.deepStrictEqual(result, { detected: 1, verified: 1 });
        assert.strictEqual(continuationCommand, 'autocode.spec.implAllTasks');
        assert.strictEqual(await readAutoTaskQueueRecord(documentUri), undefined);
    });

    test('StartAllTasks parallel batch recovery keeps only failed tasks in persisted queue state', async () => {
        const lines = [
            '# Tasks',
            '- [x] 1. Implement first batch task',
            '  - _Files: src/first.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.1_',
            '  - _Verify: npm test -- first.test.ts_',
            '  - _Done when: first task passes_',
            '- [-] 2. Implement failed batch task',
            '  - _Files: src/second.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.2_',
            '  - _Verify: npm test -- second.test.ts_',
            '  - _Done when: second task passes_'
        ];
        const taskFilePath = await writeSpec('parallel-recovery', lines);
        const documentUri = vscode.Uri.file(taskFilePath);
        const controller = new TaskQueueController(outputChannel);
        const inspector = new TaskQueueRecoveryInspector(controller, outputChannel);

        await controller.start(documentUri, 'autocode.spec.implAllTasksParallel');
        await controller.waitForBatch(documentUri, 'autocode.spec.implAllTasksParallel', [
            {
                lineNumber: 1,
                taskDescription: '1. Implement first batch task',
                completionSignalPath: path.join(path.dirname(taskFilePath), '.autocode', 'task-completion-2.json'),
                completionSignalToken: 'run-first'
            },
            {
                lineNumber: 7,
                taskDescription: '2. Implement failed batch task',
                completionSignalPath: path.join(path.dirname(taskFilePath), '.autocode', 'task-completion-8.json'),
                completionSignalToken: 'run-second'
            }
        ]);

        await controller.pause(documentUri, 'autocode.spec.implAllTasksParallel', 'One parallel task failed verification.', [7]);
        const record = await readAutoTaskQueueRecord(documentUri);
        assert.ok(record);
        assert.strictEqual(record.status, 'paused');
        assert.strictEqual(record.batchTasks?.length, 1);
        assert.strictEqual(record.batchTasks?.[0].lineNumber, 7);
        assert.strictEqual(record.batchTasks?.[0].completionSignalToken, 'run-second');

        const inspection = await inspector.inspectQueuedTasks(documentUri, record);
        assert.deepStrictEqual(inspection.pendingLineNumbers, [7]);
        assert.deepStrictEqual(inspection.completedLineNumbers, []);
        assert.strictEqual(inspection.unresolvedTasks.length, 0);
    });

    async function writeSpec(specName: string, taskLines: string[]): Promise<string> {
        const specDir = path.join(workspacePath, '.autocode', 'specs', specName);
        await fs.mkdir(specDir, { recursive: true });
        await fs.writeFile(path.join(specDir, 'requirements.md'), [
            '# Requirements',
            '## Requirement 1.1',
            'First behavior.',
            '## Requirement 1.2',
            'Second behavior.'
        ].join('\n'), 'utf8');
        await fs.writeFile(path.join(specDir, 'design.md'), '# Design\n\nUse the existing AutoCode task queue.', 'utf8');
        const taskFilePath = path.join(specDir, 'tasks.md');
        await fs.writeFile(taskFilePath, taskLines.join('\n'), 'utf8');
        return taskFilePath;
    }
});

class RecordingRuntime implements AgentRuntime {
    readonly provider: AgentProviderConfig = {
        id: 'codex',
        displayName: 'Codex',
        command: 'codex',
        capabilities: {
            permissions: false,
            expertAgents: false,
            claudeAgents: false,
            claudeHooks: false,
            claudeMcp: false,
            extensionMcp: true,
            headless: true,
            interactiveSpecWorkflow: true
        }
    };
    readonly requests: AgentInvocationRequest[] = [];

    async refreshProvider(): Promise<void> {
        return undefined;
    }

    async invokeInteractive(request: AgentInvocationRequest): Promise<vscode.Terminal> {
        this.requests.push(request);
        return {
            name: request.title ?? 'AutoCode Test Terminal',
            processId: Promise.resolve(undefined),
            creationOptions: {},
            exitStatus: undefined,
            sendText: () => undefined,
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined
        } as unknown as vscode.Terminal;
    }

    async invokeHeadless(): Promise<AgentInvocationResult> {
        return { exitCode: 0, output: '' };
    }

    async renameTerminal(): Promise<void> {
        return undefined;
    }
}

class AlwaysPassVerifier {
    isEnabled(): boolean {
        return true;
    }

    async verifyAndMarkDone(): Promise<boolean> {
        return true;
    }
}

function wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
