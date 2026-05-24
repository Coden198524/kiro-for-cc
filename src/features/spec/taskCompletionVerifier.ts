import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { getRuntimeValue } from '../../runtime/runtimeSettings';
import { replaceSpecTaskStatus } from './taskStatus';
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

        const currentTask = await this.readTaskLine(request.taskFilePath, request.lineNumber);
        if (!currentTask || !currentTask.includes('- [-]')) {
            this.outputChannel.appendLine('[TaskVerifier] Task is no longer in progress; skipping verification.');
            return false;
        }

        const prompt = this.buildVerificationPrompt(request);
        const result = await this.agentRuntime.invokeHeadless({
            prompt,
            title: 'KFC - Verify Task Completion',
            agentType: 'task_implementer'
        });

        const verification = this.parseVerification(result.output ?? '');
        if (!verification) {
            this.outputChannel.appendLine('[TaskVerifier] Could not parse verification result.');
            return false;
        }

        const minConfidence = getRuntimeValue<number>('spec.autoMarkTaskDoneMinConfidence', 0.8);
        if (!verification.completed || verification.confidence < minConfidence) {
            this.outputChannel.appendLine(`[TaskVerifier] Task not auto-completed. completed=${verification.completed}, confidence=${verification.confidence}`);
            return false;
        }

        const marked = await this.markTaskDone(request.taskFilePath, request.lineNumber);
        if (!marked) {
            return false;
        }

        await this.taskSessionManager.markCompleted(request.taskFilePath, request.lineNumber, request.taskDescription);
        vscode.window.showInformationMessage(`Task verified and marked done: ${request.taskDescription}`);
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
        const jsonText = this.extractJsonObject(output);
        if (!jsonText) {
            return undefined;
        }

        try {
            const parsed = JSON.parse(jsonText) as Partial<TaskCompletionVerification>;
            if (typeof parsed.completed !== 'boolean' || typeof parsed.confidence !== 'number') {
                return undefined;
            }

            return {
                completed: parsed.completed,
                confidence: Math.max(0, Math.min(1, parsed.confidence)),
                summary: parsed.summary,
                evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter(item => typeof item === 'string') : [],
                missing: Array.isArray(parsed.missing) ? parsed.missing.filter(item => typeof item === 'string') : []
            };
        } catch (error) {
            this.outputChannel.appendLine(`[TaskVerifier] Failed to parse verification JSON: ${error}`);
            return undefined;
        }
    }

    private extractJsonObject(output: string): string | undefined {
        const trimmed = output.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            return trimmed;
        }

        const match = trimmed.match(/\{[\s\S]*\}/);
        return match?.[0];
    }

    private async readTaskLine(taskFilePath: string, lineNumber: number): Promise<string | undefined> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(taskFilePath));
        if (lineNumber < 0 || lineNumber >= document.lineCount) {
            return undefined;
        }

        return document.lineAt(lineNumber).text;
    }

    private async markTaskDone(taskFilePath: string, lineNumber: number): Promise<boolean> {
        const uri = vscode.Uri.file(taskFilePath);
        const document = await vscode.workspace.openTextDocument(uri);
        if (lineNumber < 0 || lineNumber >= document.lineCount) {
            return false;
        }

        const line = document.lineAt(lineNumber);
        const newLine = replaceSpecTaskStatus(line.text, 'completed');
        if (!newLine || newLine === line.text) {
            return false;
        }

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(lineNumber, 0, lineNumber, line.text.length), newLine);
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
            await document.save();
        }

        return applied;
    }
}
