import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { getRuntimeValue } from '../../runtime/runtimeSettings';
import { buildSpecTaskStatusUpdates, ParsedSpecTaskLine, parseSpecTaskLine } from './taskStatus';
import { TaskSessionManager } from './taskSessionManager';
import { MemoryManager } from '../memory/memoryManager';

interface TaskCompletionVerification {
    completed: boolean;
    confidence: number;
    summary?: string;
    evidence?: string[];
    missing?: string[];
}

type TaskCompletionVerificationMode = 'fast' | 'strict';

export interface VerifyAndMarkTaskDoneRequest {
    taskFilePath: string;
    lineNumber: number;
    taskDescription: string;
}

export class TaskCompletionVerifier {
    private static readonly INTERACTIVE_VERIFICATION_POLL_INTERVAL_MS = 1000;
    private static readonly INTERACTIVE_VERIFICATION_TIMEOUT_MS = 30 * 60 * 1000;

    constructor(
        private agentRuntime: AgentRuntime,
        private taskSessionManager: TaskSessionManager,
        private outputChannel: vscode.OutputChannel,
        private memoryManager?: MemoryManager
    ) { }

    isEnabled(): boolean {
        return getRuntimeValue<boolean>('spec.autoMarkTaskDone', true);
    }

    async verifyAndMarkDone(request: VerifyAndMarkTaskDoneRequest, verificationTerminal?: vscode.Terminal): Promise<boolean> {
        if (!this.isEnabled()) {
            this.outputChannel.appendLine('[TaskVerifier] Auto mark task done is disabled.');
            return false;
        }

        const resolvedTask = await this.resolveTaskLine(request);
        if (!resolvedTask) {
            this.outputChannel.appendLine('[TaskVerifier] Could not resolve task line; skipping verification.');
            return false;
        }

        const resolvedRequest = {
            ...request,
            lineNumber: resolvedTask.lineNumber,
            taskDescription: resolvedTask.task.description
        };

        if (resolvedTask.task.status === 'completed') {
            const markedTasks = await this.markTaskDone(resolvedRequest.taskFilePath, resolvedRequest.lineNumber);
            await this.markTaskSessionsCompleted(resolvedRequest, markedTasks);
            this.outputChannel.appendLine(`[TaskVerifier] Task was already marked done: ${resolvedRequest.taskDescription}`);
            return true;
        }

        if (resolvedTask.task.status === 'pending') {
            this.outputChannel.appendLine('[TaskVerifier] Task is still pending; verifying completion anyway because completion was signaled.');
        }

        if (this.getVerificationMode() === 'fast') {
            return this.markCompletionAccepted(resolvedRequest, 'Task marked done from completion signal');
        }

        const prompt = this.buildVerificationPrompt(resolvedRequest);
        const result = verificationTerminal
            ? await this.invokeVerificationInTaskTerminal(resolvedRequest, prompt, verificationTerminal)
            : await this.agentRuntime.invokeHeadless({
                prompt,
                title: 'AutoCode - Verify Task Completion',
                agentType: 'task_implementer',
                approvalPolicy: 'never',
                visibleTerminal: true
            });

        const verification = this.parseVerification([result.output, result.stderr].filter(Boolean).join('\n'));
        if (!verification) {
            this.outputChannel.appendLine('[TaskVerifier] Could not parse verification result.');
            return false;
        }

        const minConfidence = getRuntimeValue<number>('spec.autoMarkTaskDoneMinConfidence', 0.8);
        if (!verification.completed || verification.confidence < minConfidence) {
            this.outputChannel.appendLine(`[TaskVerifier] Task not auto-completed. completed=${verification.completed}, confidence=${verification.confidence}`);
            return false;
        }

        return this.markCompletionAccepted(resolvedRequest, 'Task verified and marked done', verification);
    }

    private getVerificationMode(): TaskCompletionVerificationMode {
        if (getRuntimeValue<boolean>('spec.deferTaskVerification', false)) {
            this.outputChannel.appendLine('[TaskVerifier] Strict completion verification is bypassed because spec.deferTaskVerification is enabled.');
            return 'fast';
        }

        const mode = getRuntimeValue<string>('spec.taskCompletionVerificationMode', 'fast');
        return mode === 'strict' ? 'strict' : 'fast';
    }

    private async markCompletionAccepted(
        request: VerifyAndMarkTaskDoneRequest,
        logPrefix: string,
        verification?: TaskCompletionVerification
    ): Promise<boolean> {
        const markedTasks = await this.markTaskDone(request.taskFilePath, request.lineNumber);
        if (markedTasks.length === 0) {
            const refreshedTask = await this.resolveTaskLine(request);
            if (refreshedTask?.task.status !== 'completed') {
                this.outputChannel.appendLine('[TaskVerifier] Completion accepted but failed to update the task checkbox.');
                return false;
            }
        }

        await this.markTaskSessionsCompleted(request, markedTasks);
        await this.memoryManager?.recordTaskCompletion({
            taskFilePath: request.taskFilePath,
            lineNumber: request.lineNumber,
            taskDescription: request.taskDescription,
            verified: true,
            summary: verification?.summary ?? logPrefix,
            evidence: verification?.evidence
        });
        this.outputChannel.appendLine(`[TaskVerifier] ${logPrefix}: ${request.taskDescription}`);
        vscode.window.showInformationMessage(`${logPrefix}: ${request.taskDescription}`);
        return true;
    }

    private async invokeVerificationInTaskTerminal(
        request: VerifyAndMarkTaskDoneRequest,
        prompt: string,
        terminal: vscode.Terminal
    ): Promise<{ exitCode: number | undefined; output?: string; stderr?: string }> {
        const resultPath = this.getInteractiveVerificationResultPath(request);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resultPath)));
        await this.deleteIfExists(resultPath);

        await this.agentRuntime.invokeInteractive({
            prompt: this.buildInteractiveVerificationPrompt(prompt, resultPath, request),
            title: 'AutoCode - Verify Task Completion',
            agentType: 'task_implementer',
            approvalPolicy: 'never',
            targetTerminal: terminal
        });

        const output = await this.waitForInteractiveVerificationResult(resultPath);
        if (output === undefined) {
            return {
                exitCode: 1,
                stderr: `Task completion verification did not write a result file within ${TaskCompletionVerifier.INTERACTIVE_VERIFICATION_TIMEOUT_MS}ms: ${resultPath}`
            };
        }

        return {
            exitCode: 0,
            output
        };
    }

    private buildInteractiveVerificationPrompt(prompt: string, resultPath: string, request: VerifyAndMarkTaskDoneRequest): string {
        const payload = '{"completed":true,"confidence":0.95,"summary":"...","evidence":["..."],"missing":[]}';
        if (this.shouldUseChinese(request.taskDescription)) {
            return [
                prompt,
                '',
                '验证结果文件：',
                resultPath,
                '',
                '由于本次验证在当前任务终端中执行，请将最终 JSON 验证结果写入上面的验证结果文件。',
                '如有需要，请先创建父目录。不要修改源码文件，也不要修改任务复选框。',
                '文件内容必须是下面格式的单个 JSON 对象：',
                payload,
                '',
                '写入验证结果文件后，请在当前终端用中文简要总结验证结论。'
            ].join('\n');
        }

        return [
            prompt,
            '',
            'Verification result file:',
            resultPath,
            '',
            'Because this verification is running inside the existing task terminal, write the final JSON result to the verification result file above.',
            'Create the parent directory if needed. Do not modify source files or task checkboxes.',
            'The file content must be exactly one JSON object in this shape:',
            payload,
            '',
            'After writing the verification result file, briefly summarize the verdict in this terminal.'
        ].join('\n');
    }

    private getInteractiveVerificationResultPath(request: VerifyAndMarkTaskDoneRequest): string {
        return path.join(
            path.dirname(request.taskFilePath),
            '.autocode',
            `task-verification-${request.lineNumber + 1}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.json`
        );
    }

    private async waitForInteractiveVerificationResult(resultPath: string): Promise<string | undefined> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < TaskCompletionVerifier.INTERACTIVE_VERIFICATION_TIMEOUT_MS) {
            const output = await this.readTextIfExists(resultPath);
            if (output !== undefined && output.trim()) {
                return output;
            }

            await new Promise(resolve => setTimeout(resolve, TaskCompletionVerifier.INTERACTIVE_VERIFICATION_POLL_INTERVAL_MS));
        }

        return undefined;
    }

    private async readTextIfExists(filePath: string): Promise<string | undefined> {
        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
            return Buffer.from(content).toString().replace(/^\uFEFF/, '');
        } catch {
            return undefined;
        }
    }

    private async deleteIfExists(filePath: string): Promise<void> {
        try {
            await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
        } catch {
            // The result file normally does not exist before verification starts.
        }
    }

    private buildVerificationPrompt(request: VerifyAndMarkTaskDoneRequest): string {
        const specDir = path.dirname(request.taskFilePath);
        const requirementsPath = path.join(specDir, 'requirements.md');
        const designPath = path.join(specDir, 'design.md');

        if (this.shouldUseChinese(request.taskDescription)) {
            return [
                '你正在验证一个 Spec 实现任务是否真正完成。',
                '',
                '请检查工作区、任务文件、requirements.md、design.md、实际代码改动以及相关测试。',
                '不要修改任何文件。不要自行修改任务复选框。只输出验证结果。',
                '',
                `任务文件：${request.taskFilePath}`,
                `需求文件：${requirementsPath}`,
                `设计文件：${designPath}`,
                `任务行号：${request.lineNumber + 1}`,
                `任务描述：${request.taskDescription}`,
                '',
                '完成标准：',
                '- 实现内容符合 requirements.md 和 design.md。',
                '- 已存在并通过相关测试或验证命令；如果无法运行，必须有明确、可信的原因。',
                '- 没有明显回归、未完成占位、无关大改或范围外修改。',
                '- 实现范围与当前任务一致。',
                '',
                '只返回一个 JSON 对象，不要使用 markdown：',
                '{"completed":true,"confidence":0.95,"summary":"...","evidence":["..."],"missing":[]}',
                '',
                '如果存在任何不确定、未完成、未验证或阻塞项，请返回 completed=false，并在 missing 中列出原因。',
                'JSON 字段名必须保持英文；summary、evidence、missing 的文本内容请使用中文。'
            ].join('\n');
        }

        return [
            'You are verifying whether a single spec implementation task is truly complete.',
            '',
            'Inspect the workspace, the task file, requirements, design, implementation changes, and relevant tests.',
            'Do not modify files. Do not mark the task done yourself. Only report the verification result.',
            '',
            `Task File: ${request.taskFilePath}`,
            `Requirements File: ${requirementsPath}`,
            `Design File: ${designPath}`,
            `Task Line: ${request.lineNumber + 1}`,
            `Task Description: ${request.taskDescription}`,
            '',
            'Completion criteria:',
            '- The requested task is implemented according to requirements and design.',
            '- Relevant tests or verification commands exist and pass, or there is a concrete reason tests are not applicable.',
            '- No obvious regressions, incomplete placeholders, or unrelated broad changes remain.',
            '- The implementation is scoped to this task.',
            '',
            'Return exactly one JSON object and no markdown:',
            '{"completed":true,"confidence":0.95,"summary":"...","evidence":["..."],"missing":[]}',
            '',
            'If anything is uncertain, incomplete, untested, or blocked, return completed=false with missing items.'
        ].join('\n');
    }

    private shouldUseChinese(text: string): boolean {
        return /[\u3400-\u9FFF]/.test(text);
    }

    private parseVerification(output: string): TaskCompletionVerification | undefined {
        for (const jsonText of this.extractJsonObjects(output)) {
            try {
                const parsed = JSON.parse(jsonText) as Partial<TaskCompletionVerification>;
                if (typeof parsed.completed !== 'boolean' || typeof parsed.confidence !== 'number') {
                    continue;
                }

                return {
                    completed: parsed.completed,
                    confidence: Math.max(0, Math.min(1, parsed.confidence)),
                    summary: parsed.summary,
                    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter(item => typeof item === 'string') : [],
                    missing: Array.isArray(parsed.missing) ? parsed.missing.filter(item => typeof item === 'string') : []
                };
            } catch (error) {
                this.outputChannel.appendLine(`[TaskVerifier] Failed to parse verification JSON candidate: ${error}`);
            }
        }

        return undefined;
    }

    private extractJsonObjects(output: string): string[] {
        const trimmed = output.trim();
        const candidates: string[] = [];
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            candidates.push(trimmed);
        }

        let depth = 0;
        let start = -1;
        let inString = false;
        let escaped = false;

        for (let index = 0; index < output.length; index++) {
            const char = output[index];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
                continue;
            }

            if (char === '{') {
                if (depth === 0) {
                    start = index;
                }
                depth += 1;
                continue;
            }

            if (char === '}' && depth > 0) {
                depth -= 1;
                if (depth === 0 && start >= 0) {
                    candidates.push(output.slice(start, index + 1));
                    start = -1;
                }
            }
        }

        return [...new Set(candidates)];
    }

    private async resolveTaskLine(request: VerifyAndMarkTaskDoneRequest): Promise<{ lineNumber: number; task: ParsedSpecTaskLine } | undefined> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(request.taskFilePath));
        if (request.lineNumber >= 0 && request.lineNumber < document.lineCount) {
            const task = parseSpecTaskLine(document.lineAt(request.lineNumber).text);
            if (task && this.isSameTask(task.description, request.taskDescription)) {
                return {
                    lineNumber: request.lineNumber,
                    task
                };
            }
        }

        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
            const task = parseSpecTaskLine(document.lineAt(lineNumber).text);
            if (task && this.isSameTask(task.description, request.taskDescription)) {
                this.outputChannel.appendLine(`[TaskVerifier] Resolved moved task line ${request.lineNumber + 1} -> ${lineNumber + 1}: ${request.taskDescription}`);
                return {
                    lineNumber,
                    task
                };
            }
        }

        return undefined;
    }

    private isSameTask(actual: string, expected: string): boolean {
        return actual.trim() === expected.trim();
    }

    private async markTaskDone(taskFilePath: string, lineNumber: number): Promise<Array<{ lineNumber: number; description: string }>> {
        const uri = vscode.Uri.file(taskFilePath);
        const document = await vscode.workspace.openTextDocument(uri);
        if (lineNumber < 0 || lineNumber >= document.lineCount) {
            return [];
        }

        const lines = this.getDocumentLines(document);
        const updates = buildSpecTaskStatusUpdates(lines, lineNumber, 'completed');
        if (updates.length === 0) {
            return [];
        }

        const edit = new vscode.WorkspaceEdit();
        for (const update of updates) {
            edit.replace(uri, new vscode.Range(update.lineNumber, 0, update.lineNumber, update.oldText.length), update.newText);
        }
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
            await document.save();
        }

        return applied
            ? updates.map(update => ({
                lineNumber: update.lineNumber,
                description: update.task.description
            }))
            : [];
    }

    private async markTaskSessionsCompleted(
        request: VerifyAndMarkTaskDoneRequest,
        markedTasks: Array<{ lineNumber: number; description: string }>
    ): Promise<void> {
        await this.taskSessionManager.markCompleted(request.taskFilePath, request.lineNumber, request.taskDescription);
        for (const parentTask of markedTasks.filter(task => task.lineNumber !== request.lineNumber)) {
            await this.taskSessionManager.markCompleted(request.taskFilePath, parentTask.lineNumber, parentTask.description);
        }
    }

    private getDocumentLines(document: vscode.TextDocument): string[] {
        const lines: string[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            lines.push(document.lineAt(i).text);
        }
        return lines;
    }
}
