import * as path from 'path';
import * as vscode from 'vscode';
import { MemoryManager } from '../memory/memoryManager';
import { localize } from '../../utils/localization';
import { hasChildSpecTasks, parseSpecTaskLine } from './taskStatus';

export type FinalVerificationKind = 'command' | 'manual';

export interface FinalVerificationItem {
    lineNumber: number;
    taskId?: string;
    taskDescription: string;
    value: string;
    kind: FinalVerificationKind;
}

export interface FinalVerificationPlan {
    specName: string;
    taskFilePath: string;
    reportPath: string;
    commandItems: FinalVerificationItem[];
    manualItems: FinalVerificationItem[];
    duplicateCount: number;
}

export class FinalVerificationManager {
    constructor(
        private outputChannel: vscode.OutputChannel,
        private memoryManager?: MemoryManager
    ) { }

    async run(tasksDocumentUri: vscode.Uri): Promise<FinalVerificationPlan | undefined> {
        const plan = await this.buildPlan(tasksDocumentUri);
        if (plan.commandItems.length === 0 && plan.manualItems.length === 0) {
            vscode.window.showWarningMessage(localize(
                'No _Verify:_ metadata was found in leaf tasks.',
                '没有在叶子任务中找到 _Verify:_ 元数据。'
            ));
            return plan;
        }

        await this.writeReport(plan);
        await this.recordSpecArchive(plan);
        this.launchVisibleTerminal(plan);

        vscode.window.showInformationMessage(localize(
            `Final verification started for ${plan.specName}. Report: ${plan.reportPath}`,
            `已启动 ${plan.specName} 的最终验证。报告：${plan.reportPath}`
        ));
        return plan;
    }

    async buildPlan(tasksDocumentUri: vscode.Uri): Promise<FinalVerificationPlan> {
        const content = await vscode.workspace.fs.readFile(tasksDocumentUri);
        const lines = Buffer.from(content).toString('utf8').split(/\r?\n/);
        const allItems = collectFinalVerificationItems(lines);
        const { items: commandItems, duplicateCount: commandDuplicateCount } = dedupeVerificationItems(
            allItems.filter(item => item.kind === 'command')
        );
        const { items: manualItems, duplicateCount: manualDuplicateCount } = dedupeVerificationItems(
            allItems.filter(item => item.kind === 'manual')
        );

        return {
            specName: path.basename(path.dirname(tasksDocumentUri.fsPath)),
            taskFilePath: tasksDocumentUri.fsPath,
            reportPath: path.join(path.dirname(tasksDocumentUri.fsPath), 'verification', 'final-report.md'),
            commandItems,
            manualItems,
            duplicateCount: commandDuplicateCount + manualDuplicateCount
        };
    }

    private async writeReport(plan: FinalVerificationPlan): Promise<void> {
        const reportUri = vscode.Uri.file(plan.reportPath);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(plan.reportPath)));
        await vscode.workspace.fs.writeFile(reportUri, Buffer.from(formatFinalVerificationReport(plan), 'utf8'));
        this.outputChannel.appendLine(`[Final Verification] Report written: ${plan.reportPath}`);
    }

    private async recordSpecArchive(plan: FinalVerificationPlan): Promise<void> {
        if (!this.memoryManager) {
            return;
        }

        const specDir = path.dirname(plan.taskFilePath);
        try {
            await this.memoryManager.recordSpecArchive({
                specName: plan.specName,
                taskFilePath: plan.taskFilePath,
                requirementsPath: path.join(specDir, 'requirements.md'),
                designPath: path.join(specDir, 'design.md'),
                tasksPath: plan.taskFilePath,
                reportPath: plan.reportPath,
                commandChecks: plan.commandItems.map(toSpecArchiveCheck),
                manualChecks: plan.manualItems.map(toSpecArchiveCheck),
                duplicateCheckCount: plan.duplicateCount
            });
            this.outputChannel.appendLine(`[Final Verification] Spec archive memory recorded for ${plan.specName}.`);
        } catch (error) {
            this.outputChannel.appendLine(`[Final Verification] Failed to record spec archive memory: ${error}`);
        }
    }

    private launchVisibleTerminal(plan: FinalVerificationPlan): void {
        if (plan.commandItems.length === 0) {
            this.outputChannel.appendLine('[Final Verification] No command checks to launch.');
            return;
        }

        const workspacePath = this.getWorkspacePath(plan.taskFilePath);
        const terminal = vscode.window.createTerminal({
            name: localize(`Final Verification: ${plan.specName}`, `最终验证: ${plan.specName}`),
            cwd: workspacePath
        });
        terminal.show();

        for (const item of plan.commandItems) {
            terminal.sendText(item.value);
        }

        this.outputChannel.appendLine(`[Final Verification] Launched ${plan.commandItems.length} command(s) in a visible terminal.`);
    }

    private getWorkspacePath(filePath: string): string | undefined {
        const normalizedFilePath = normalizeFsPath(filePath);
        const matchingFolder = vscode.workspace.workspaceFolders
            ?.filter(folder => normalizedFilePath.startsWith(`${normalizeFsPath(folder.uri.fsPath)}${path.sep}`) ||
                normalizedFilePath === normalizeFsPath(folder.uri.fsPath))
            .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0];

        return matchingFolder?.uri.fsPath;
    }
}

export function collectFinalVerificationItems(lines: readonly string[]): FinalVerificationItem[] {
    const items: FinalVerificationItem[] = [];

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const task = parseSpecTaskLine(lines[lineNumber]);
        if (!task || hasChildSpecTasks(lines, lineNumber)) {
            continue;
        }

        const verifyValue = extractVerifyValue(getTaskDetailLines(lines, lineNumber));
        if (!verifyValue) {
            continue;
        }

        items.push({
            lineNumber,
            taskId: parseTaskId(task.description),
            taskDescription: task.description,
            value: verifyValue,
            kind: isManualVerification(verifyValue) ? 'manual' : 'command'
        });
    }

    return items;
}

export function formatFinalVerificationReport(plan: FinalVerificationPlan, generatedAt = new Date()): string {
    const lines = [
        '# Final Verification Report',
        '',
        `- Spec: ${plan.specName}`,
        `- Task file: ${plan.taskFilePath}`,
        `- Generated: ${generatedAt.toISOString()}`,
        `- Unique command checks: ${plan.commandItems.length}`,
        `- Manual checks: ${plan.manualItems.length}`,
        `- Duplicate checks skipped: ${plan.duplicateCount}`,
        '',
        '## Command Checks',
        ''
    ];

    if (plan.commandItems.length === 0) {
        lines.push('No command checks were found.', '');
    } else {
        lines.push('| Task | Line | Command |', '| --- | ---: | --- |');
        for (const item of plan.commandItems) {
            lines.push(`| ${escapeMarkdownTableCell(item.taskId ?? item.taskDescription)} | ${item.lineNumber + 1} | \`${escapeMarkdownTableCell(item.value)}\` |`);
        }
        lines.push('');
    }

    lines.push('## Manual Checks', '');
    if (plan.manualItems.length === 0) {
        lines.push('No manual checks were found.', '');
    } else {
        lines.push('| Task | Line | Check |', '| --- | ---: | --- |');
        for (const item of plan.manualItems) {
            lines.push(`| ${escapeMarkdownTableCell(item.taskId ?? item.taskDescription)} | ${item.lineNumber + 1} | ${escapeMarkdownTableCell(item.value)} |`);
        }
        lines.push('');
    }

    lines.push(
        '## Notes',
        '',
        'AutoCode launched the command checks in a visible terminal. Review terminal output, then update this report or task status as needed.'
    );

    return lines.join('\n');
}

function getTaskDetailLines(lines: readonly string[], lineNumber: number): string[] {
    const task = parseSpecTaskLine(lines[lineNumber]);
    if (!task) {
        return [];
    }

    const taskIndent = indentationWidth(task.indentation);
    const detailLines: string[] = [];

    for (let index = lineNumber + 1; index < lines.length; index++) {
        const candidate = parseSpecTaskLine(lines[index]);
        if (candidate && indentationWidth(candidate.indentation) <= taskIndent) {
            break;
        }

        detailLines.push(lines[index]);
    }

    return detailLines;
}

function extractVerifyValue(detailLines: readonly string[]): string | undefined {
    for (const line of detailLines) {
        const match = line.trim().match(/^(?:[-*]\s*)?_?(Verify|Verification|验证|验证方式)\s*[:：]\s*(.*?)_?$/i);
        if (!match) {
            continue;
        }

        const value = stripDecorators(match[2]);
        if (value) {
            return value;
        }
    }

    return undefined;
}

function stripDecorators(value: string): string {
    return value
        .trim()
        .replace(/^[_`"']+/, '')
        .replace(/[_`"',;]+$/, '')
        .trim();
}

function isManualVerification(value: string): boolean {
    return /^(manual|manually|inspect|review|open vscode|unity test runner|手动|人工|检查|验证)\b/i.test(value.trim());
}

function dedupeVerificationItems(items: readonly FinalVerificationItem[]): { items: FinalVerificationItem[]; duplicateCount: number } {
    const seen = new Set<string>();
    const deduped: FinalVerificationItem[] = [];

    for (const item of items) {
        const key = item.value.replace(/\s+/g, ' ').trim().toLowerCase();
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        deduped.push(item);
    }

    return {
        items: deduped,
        duplicateCount: items.length - deduped.length
    };
}

function parseTaskId(description: string): string | undefined {
    return description.trim().match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+/)?.[1];
}

function toSpecArchiveCheck(item: FinalVerificationItem): {
    lineNumber: number;
    taskId?: string;
    taskDescription: string;
    value: string;
} {
    return {
        lineNumber: item.lineNumber,
        taskId: item.taskId,
        taskDescription: item.taskDescription,
        value: item.value
    };
}

function indentationWidth(indentation: string): number {
    return indentation.replace(/\t/g, '    ').length;
}

function normalizeFsPath(filePath: string): string {
    const normalized = path.normalize(filePath);
    return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
