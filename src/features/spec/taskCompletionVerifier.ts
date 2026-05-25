import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { getRuntimeValue } from '../../runtime/runtimeSettings';
import { buildSpecTaskStatusUpdates, ParsedSpecTaskLine, parseSpecTaskLine } from './taskStatus';
import { TaskSessionManager } from './taskSessionManager';

interface TaskCompletionVerification {
    completed: boolean;
    confidence: number;
    summary?: string;
    evidence?: string[];
    missing?: string[];
}

export interface VerifyAndMarkTaskDoneRequest {
    taskFilePath: string;
    lineNumber: number;
    taskDescription: string;
}

export class TaskCompletionVerifier {
    constructor(
        private agentRuntime: AgentRuntime,
        private taskSessionManager: TaskSessionManager,
        private outputChannel: vscode.OutputChannel
    ) { }

    isEnabled(): boolean {
        return getRuntimeValue<boolean>('spec.autoMarkTaskDone', true);
    }

    async verifyAndMarkDone(request: VerifyAndMarkTaskDoneRequest): Promise<boolean> {
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

        const prompt = this.buildVerificationPrompt(resolvedRequest);
        const result = await this.agentRuntime.invokeHeadless({
            prompt,
            title: 'AutoCode - Verify Task Completion',
            agentType: 'task_implementer',
            approvalPolicy: 'never'
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

        const markedTasks = await this.markTaskDone(resolvedRequest.taskFilePath, resolvedRequest.lineNumber);
        if (markedTasks.length === 0) {
            const refreshedTask = await this.resolveTaskLine(resolvedRequest);
            if (refreshedTask?.task.status !== 'completed') {
                this.outputChannel.appendLine('[TaskVerifier] Verification passed but failed to update the task checkbox.');
                return false;
            }
        }

        await this.markTaskSessionsCompleted(resolvedRequest, markedTasks);
        this.outputChannel.appendLine(`[TaskVerifier] Task verified and marked done: ${resolvedRequest.taskDescription}`);
        vscode.window.showInformationMessage(`Task verified and marked done: ${resolvedRequest.taskDescription}`);
        return true;
    }

    private buildVerificationPrompt(request: VerifyAndMarkTaskDoneRequest): string {
        const specDir = path.dirname(request.taskFilePath);
        const requirementsPath = path.join(specDir, 'requirements.md');
        const designPath = path.join(specDir, 'design.md');

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
