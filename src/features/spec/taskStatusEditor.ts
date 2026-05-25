import * as vscode from 'vscode';
import {
    buildSpecTaskStatusUpdates,
    hasChildSpecTasks,
    parseSpecTaskLine,
    replaceSpecTaskStatus,
    SpecTaskStatus
} from './taskStatus';

export interface TaskStatusEditResult {
    task: NonNullable<ReturnType<typeof parseSpecTaskLine>>;
    parentTasks: Array<{ lineNumber: number; description: string }>;
    changedLineNumbers: number[];
}

export async function updateTaskLineStatus(
    documentUri: vscode.Uri,
    lineNumber: number,
    status: SpecTaskStatus
): Promise<TaskStatusEditResult | undefined> {
    const document = await vscode.workspace.openTextDocument(documentUri);
    const line = document.lineAt(lineNumber);
    const task = parseSpecTaskLine(line.text);
    if (!task) {
        return undefined;
    }

    if (task.status === 'completed' && status !== 'completed') {
        return { task, parentTasks: [], changedLineNumbers: [] };
    }

    const updates = status === 'completed'
        ? buildSpecTaskStatusUpdates(getDocumentLines(document), lineNumber, status)
        : buildSingleTaskStatusUpdate(line.text, lineNumber, status);
    if (updates.length === 0) {
        return { task, parentTasks: [], changedLineNumbers: [] };
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
            })),
        changedLineNumbers: applied ? updates.map(update => update.lineNumber) : []
    };
}

export async function markRunnableTasksInProgress(documentUri: vscode.Uri): Promise<number[]> {
    const document = await vscode.workspace.openTextDocument(documentUri);
    const lines = getDocumentLines(document);
    const edit = new vscode.WorkspaceEdit();
    const changedLineNumbers: number[] = [];

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
        changedLineNumbers.push(lineNumber);
    }

    if (changedLineNumbers.length === 0) {
        return [];
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
        await document.save();
        return changedLineNumbers;
    }

    return [];
}

export async function markTaskLinesInProgress(documentUri: vscode.Uri, lineNumbers: readonly number[]): Promise<number[]> {
    return markTaskLinesStatus(documentUri, lineNumbers, 'pending', 'inProgress');
}

export async function markTaskLinesPending(documentUri: vscode.Uri, lineNumbers: readonly number[]): Promise<number[]> {
    return markTaskLinesStatus(documentUri, lineNumbers, 'inProgress', 'pending');
}

async function markTaskLinesStatus(
    documentUri: vscode.Uri,
    lineNumbers: readonly number[],
    currentStatus: SpecTaskStatus,
    nextStatus: SpecTaskStatus
): Promise<number[]> {
    const document = await vscode.workspace.openTextDocument(documentUri);
    const lineNumberSet = new Set(lineNumbers);
    const edit = new vscode.WorkspaceEdit();
    const changedLineNumbers: number[] = [];

    for (const lineNumber of lineNumberSet) {
        if (lineNumber < 0 || lineNumber >= document.lineCount) {
            continue;
        }

        const line = document.lineAt(lineNumber);
        const task = parseSpecTaskLine(line.text);
        if (!task || task.status !== currentStatus) {
            continue;
        }

        const newLine = replaceSpecTaskStatus(line.text, nextStatus);
        if (!newLine || newLine === line.text) {
            continue;
        }

        edit.replace(documentUri, new vscode.Range(lineNumber, 0, lineNumber, line.text.length), newLine);
        changedLineNumbers.push(lineNumber);
    }

    if (changedLineNumbers.length === 0) {
        return [];
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
        await document.save();
        return changedLineNumbers;
    }

    return [];
}

export async function readTaskLine(documentUri: vscode.Uri, lineNumber: number): Promise<ReturnType<typeof parseSpecTaskLine>> {
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
