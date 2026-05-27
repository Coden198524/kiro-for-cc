import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { PromptLoader } from '../../services/promptLoader';
import { ConfigManager } from '../../utils/configManager';
import { NotificationUtils } from '../../utils/notificationUtils';
import { SpecDescriptionInput } from '../spec/specDescriptionInput';
import { MemoryManager } from '../memory/memoryManager';
import { localize } from '../../utils/localization';

const execFileAsync = promisify(execFile);

export type IterationMode = 'ask' | 'edit' | 'document';

export interface IterationRecord {
    id: string;
    title: string;
    mode: IterationMode;
    description: string;
    workspacePath: string;
    promptPath: string;
    summaryPath: string;
    recordPath: string;
    provider: string;
    model?: string;
    activeFilePath?: string;
    startedAt: string;
}

export interface IterationStartOptions {
    mode?: IterationMode;
    description?: string;
}

interface IterationContext {
    activeFileContext: string;
    diagnosticsContext: string;
    gitContext: string;
    steeringContext: string;
    memoryContext: string;
}

export class IterationManager {
    private readonly promptLoader = PromptLoader.getInstance();
    private readonly configManager = ConfigManager.getInstance();

    constructor(
        private agentRuntime: AgentRuntime,
        private outputChannel: vscode.OutputChannel,
        private memoryManager?: MemoryManager
    ) { }

    async start(options: IterationStartOptions = {}): Promise<IterationRecord | undefined> {
        await this.agentRuntime.refreshProvider?.();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        const mode = options.mode ?? await this.pickMode();
        if (!mode) {
            return undefined;
        }

        const description = options.description ?? await this.promptForDescription(mode);
        if (!description?.trim()) {
            return undefined;
        }

        const startedAt = new Date();
        const id = this.createIterationId(startedAt, description);
        const title = this.createTitle(mode, description);
        const iterationDir = path.join(workspaceFolder.uri.fsPath, '.autocode', 'iterations');
        const promptPath = path.join(iterationDir, `${id}.prompt.md`);
        const summaryPath = path.join(iterationDir, `${id}.summary.md`);
        const recordPath = path.join(iterationDir, `${id}.json`);
        const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        const context = await this.collectContext(workspaceFolder.uri.fsPath, description);

        const prompt = this.promptLoader.renderPrompt('start-iteration', {
            mode,
            modeLabel: this.getModeLabel(mode),
            modeInstruction: this.getModeInstruction(mode),
            description,
            workspacePath: workspaceFolder.uri.fsPath,
            activeFileContext: context.activeFileContext,
            diagnosticsContext: context.diagnosticsContext,
            gitContext: context.gitContext,
            steeringContext: context.steeringContext,
            memoryContext: context.memoryContext,
            summaryPath
        });

        const record: IterationRecord = {
            id,
            title,
            mode,
            description,
            workspacePath: workspaceFolder.uri.fsPath,
            promptPath,
            summaryPath,
            recordPath,
            provider: this.agentRuntime.provider.displayName,
            model: this.agentRuntime.provider.model,
            activeFilePath,
            startedAt: startedAt.toISOString()
        };

        await vscode.workspace.fs.createDirectory(vscode.Uri.file(iterationDir));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(promptPath), Buffer.from(prompt, 'utf8'));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(recordPath), Buffer.from(JSON.stringify(record, null, 2), 'utf8'));

        await this.agentRuntime.invokeInteractive({
            prompt,
            title: `Iteration: ${title}`,
            agentType: mode === 'ask' ? 'spec_orchestrator' : 'task_implementer',
            reuseTerminal: false
        });

        this.outputChannel.appendLine(`[Iteration] Started ${mode} iteration ${id}: ${title}`);
        NotificationUtils.showAutoDismissNotification(`${this.agentRuntime.provider.displayName} started an iteration session. Check the terminal for progress.`);

        return record;
    }

    async listRecent(limit = 10): Promise<IterationRecord[]> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return [];
        }

        const iterationDir = path.join(workspaceFolder.uri.fsPath, '.autocode', 'iterations');
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(iterationDir));
        } catch {
            return [];
        }

        const records: IterationRecord[] = [];
        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File || !name.endsWith('.json')) {
                continue;
            }

            try {
                const filePath = path.join(iterationDir, name);
                const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                const parsed = JSON.parse(Buffer.from(content).toString('utf8')) as IterationRecord;
                if (parsed?.id && parsed?.startedAt) {
                    records.push({
                        ...parsed,
                        recordPath: parsed.recordPath || filePath
                    });
                }
            } catch (error) {
                this.outputChannel.appendLine(`[Iteration] Failed to read iteration record ${name}: ${error}`);
            }
        }

        return records
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
            .slice(0, Math.max(1, limit));
    }

    async openRecord(record: IterationRecord): Promise<void> {
        await this.openFile(record.recordPath);
    }

    async openPrompt(record: IterationRecord): Promise<void> {
        await this.openFile(record.promptPath);
    }

    async openSummary(record: IterationRecord): Promise<void> {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(record.summaryPath));
        } catch {
            vscode.window.showWarningMessage('This iteration has no summary file yet.');
            return;
        }

        await this.openFile(record.summaryPath);
    }

    async buildSpecDescription(record: IterationRecord): Promise<string> {
        const summary = await this.readOptionalText(record.summaryPath);
        const prompt = await this.readOptionalText(record.promptPath);
        return [
            'Create a full AutoCode Spec from this lightweight iteration.',
            '',
            `Iteration mode: ${this.getModeLabel(record.mode)}`,
            `Started: ${record.startedAt}`,
            `Iteration record: ${record.recordPath}`,
            `Prompt file: ${record.promptPath}`,
            `Summary file: ${record.summaryPath}`,
            record.activeFilePath ? `Active file: ${record.activeFilePath}` : undefined,
            '',
            'Original iteration request:',
            '',
            record.description,
            summary ? ['', 'Iteration summary:', '', summary] : undefined,
            !summary && prompt ? ['', 'Iteration prompt excerpt:', '', this.truncate(prompt, 6000)] : undefined,
            '',
            'Use the iteration request, saved prompt, and summary as source context. Re-check the current repository state before finalizing requirements, design, and tasks through the normal Spec workflow.'
        ].flat().filter((line): line is string => line !== undefined).join('\n');
    }

    async buildContinuationDescription(record: IterationRecord): Promise<string> {
        const summary = await this.readOptionalText(record.summaryPath);
        return [
            'Continue this previous AutoCode iteration.',
            '',
            `Previous mode: ${this.getModeLabel(record.mode)}`,
            `Started: ${record.startedAt}`,
            `Iteration record: ${record.recordPath}`,
            `Prompt file: ${record.promptPath}`,
            record.activeFilePath ? `Previous active file: ${record.activeFilePath}` : undefined,
            '',
            'Original request:',
            '',
            record.description,
            summary ? ['', 'Previous summary:', '', summary] : undefined,
            '',
            'Before continuing, inspect the current worktree and relevant files. Avoid repeating completed work, preserve unrelated user changes, and continue from the current repository state.'
        ].flat().filter((line): line is string => line !== undefined).join('\n');
    }

    async continue(record: IterationRecord): Promise<IterationRecord | undefined> {
        return this.start({
            mode: record.mode,
            description: await this.buildContinuationDescription(record)
        });
    }

    private async openFile(filePath: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(document, { preview: false });
    }

    private async readOptionalText(filePath: string): Promise<string | undefined> {
        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
            return Buffer.from(content).toString('utf8').trim();
        } catch {
            return undefined;
        }
    }

    private async pickMode(): Promise<IterationMode | undefined> {
        const selected = await vscode.window.showQuickPick([
            {
                label: this.getModeLabel('ask'),
                description: localize(
                    'Read code, diagnostics, logs, or failures without changing files by default',
                    '默认只阅读代码、诊断、日志或失败信息，不修改文件'
                ),
                mode: 'ask' as const
            },
            {
                label: this.getModeLabel('edit'),
                description: localize(
                    'Make a focused code change and run narrow verification',
                    '进行聚焦代码修改，并运行最小必要验证'
                ),
                mode: 'edit' as const
            },
            {
                label: this.getModeLabel('document'),
                description: localize(
                    'Draft or update documentation from project context',
                    '基于项目上下文生成或更新文档'
                ),
                mode: 'document' as const
            },
        ], {
            placeHolder: localize('Choose an iteration mode', '选择迭代模式')
        });

        return selected?.mode;
    }

    private async promptForDescription(mode: IterationMode): Promise<string | undefined> {
        return SpecDescriptionInput.prompt({
            title: localize(`Start Iteration: ${this.getModeLabel(mode)}`, `启动迭代：${this.getModeLabel(mode)}`),
            prompt: localize(
                'Describe what you want to ask, analyze, change, or document. Multi-line notes, logs, examples, and constraints are supported.',
                '描述你想询问、分析、修改或生成文档的内容。支持多行说明、日志、示例和约束。'
            ),
            placeholder: localize(
                'Paste the issue, question, desired change, error output, or document request...',
                '粘贴问题、期望修改、错误输出或文档需求...'
            )
        });
    }

    private async collectContext(workspacePath: string, description: string): Promise<IterationContext> {
        const [activeFileContext, diagnosticsContext, gitContext, steeringContext, memoryContext] = await Promise.all([
            this.getActiveFileContext(),
            this.getDiagnosticsContext(),
            this.getGitContext(workspacePath),
            this.getSteeringContext(workspacePath),
            this.getMemoryContext(description)
        ]);

        return {
            activeFileContext,
            diagnosticsContext,
            gitContext,
            steeringContext,
            memoryContext
        };
    }

    private async getActiveFileContext(): Promise<string> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return 'No active editor file.';
        }

        const document = editor.document;
        const parts = [
            `Active file: ${document.uri.fsPath}`,
            `Language: ${document.languageId ?? 'unknown'}`
        ];

        const selection = editor.selection;
        if (selection && selection.isEmpty === false) {
            parts.push('', 'Selected text:', this.truncate(document.getText(selection), 12000));
        } else {
            parts.push('', 'Active file excerpt:', this.truncate(document.getText(), 12000));
        }

        return parts.join('\n');
    }

    private async getDiagnosticsContext(): Promise<string> {
        const diagnosticsApi = (vscode.languages as typeof vscode.languages & {
            getDiagnostics?: (uri?: vscode.Uri) => [vscode.Uri, vscode.Diagnostic[]][] | vscode.Diagnostic[];
        }).getDiagnostics;
        if (!diagnosticsApi) {
            return 'VS Code diagnostics are unavailable.';
        }

        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const diagnostics = activeUri
            ? diagnosticsApi(activeUri) as vscode.Diagnostic[]
            : [];
        if (!diagnostics || diagnostics.length === 0) {
            return 'No diagnostics were reported for the active file.';
        }

        return diagnostics.slice(0, 20).map(diagnostic => {
            const line = diagnostic.range?.start?.line !== undefined ? diagnostic.range.start.line + 1 : '?';
            const source = diagnostic.source ? `[${diagnostic.source}] ` : '';
            return `- line ${line}: ${source}${diagnostic.message}`;
        }).join('\n');
    }

    private async getGitContext(workspacePath: string): Promise<string> {
        const status = await this.runGit(workspacePath, ['status', '--short']);
        const diffStat = await this.runGit(workspacePath, ['diff', '--stat']);
        const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        const relativeActivePath = activeFilePath && this.toWorkspaceRelativePath(workspacePath, activeFilePath);
        const activeDiff = relativeActivePath
            ? await this.runGit(workspacePath, ['diff', '--', relativeActivePath])
            : '';

        return [
            'Git status:',
            status || '(clean or unavailable)',
            '',
            'Git diff stat:',
            diffStat || '(no diff stat or unavailable)',
            '',
            relativeActivePath ? `Active file diff (${relativeActivePath}):` : 'Active file diff:',
            activeDiff ? this.truncate(activeDiff, 12000) : '(no active file diff or unavailable)'
        ].join('\n');
    }

    private async runGit(cwd: string, args: string[]): Promise<string> {
        try {
            const result = await execFileAsync('git', args, {
                cwd,
                timeout: 1500,
                maxBuffer: 1024 * 256
            });
            return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        } catch {
            return '';
        }
    }

    private async getSteeringContext(workspacePath: string): Promise<string> {
        await this.configManager.loadSettings();
        const steeringDir = path.join(workspacePath, this.configManager.getPath('steering'));
        const names = ['product.md', 'tech.md', 'structure.md'];
        const sections: string[] = [];

        for (const name of names) {
            const filePath = path.join(steeringDir, name);
            try {
                const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                sections.push(`## ${name}\n${this.truncate(Buffer.from(content).toString('utf8'), 5000)}`);
            } catch {
                // Project context is optional for quick iterations.
            }
        }

        return sections.length > 0
            ? sections.join('\n\n')
            : 'No project context documents were found.';
    }

    private async getMemoryContext(description: string): Promise<string> {
        if (!this.memoryManager) {
            return 'No AutoCode memory manager is available.';
        }

        try {
            return await this.memoryManager.buildPromptContext({
                query: description,
                includeUserPreferences: true,
                maxItems: 6
            });
        } catch (error) {
            this.outputChannel.appendLine(`[Iteration] Failed to build memory context: ${error}`);
            return 'AutoCode memory retrieval failed for this iteration.';
        }
    }

    private getModeLabel(mode: IterationMode): string {
        switch (mode) {
            case 'ask':
                return localize('Ask / Analyze', '询问 / 分析');
            case 'edit':
                return localize('Edit / Fix', '编辑 / 修复');
            case 'document':
                return localize('Generate Document', '生成文档');
        }
    }

    private getModeInstruction(mode: IterationMode): string {
        switch (mode) {
            case 'ask':
                return 'Default to analysis only. Cover normal code questions, architecture questions, diagnostics, logs, build errors, and test failures. Do not modify files unless the user explicitly asked for edits in this iteration request. Prefer concrete file references, concise reasoning, and actionable next steps.';
            case 'edit':
                return 'Make the smallest coherent code change that addresses the request. Preserve existing style, avoid unrelated refactors, add or update focused tests when risk warrants it, and run the narrowest useful verification command.';
            case 'document':
                return 'Create or update documentation only when the request asks for file output. Otherwise provide the document content in the terminal response. Ground the writing in the actual project context and avoid generic filler.';
        }
    }

    private createIterationId(date: Date, description: string): string {
        const timestamp = date.toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}Z$/, 'Z');
        const slug = this.slugify(description).slice(0, 40) || 'iteration';
        return `${timestamp}-${slug}`;
    }

    private createTitle(mode: IterationMode, description: string): string {
        const cleaned = description
            .replace(/\s+/g, ' ')
            .trim();
        const title = this.truncate(cleaned, 54);
        return `${this.getModeLabel(mode)}${title ? `: ${title}` : ''}`;
    }

    private slugify(value: string): string {
        return value
            .normalize('NFKD')
            .toLowerCase()
            .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    private toWorkspaceRelativePath(workspacePath: string, filePath: string): string | undefined {
        const relativePath = path.relative(workspacePath, filePath);
        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return undefined;
        }

        return relativePath;
    }

    private truncate(value: string, maxLength: number): string {
        const chars = Array.from(value);
        if (chars.length <= maxLength) {
            return value;
        }

        return `${chars.slice(0, Math.max(0, maxLength - 24)).join('')}\n\n[truncated ${chars.length - maxLength + 24} chars]`;
    }
}
