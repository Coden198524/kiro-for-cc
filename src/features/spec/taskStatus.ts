export type SpecTaskStatus = 'pending' | 'inProgress' | 'completed';

export interface ParsedSpecTaskLine {
    indentation: string;
    marker: string;
    status: SpecTaskStatus;
    description: string;
}

export interface SpecTaskStatusUpdate {
    lineNumber: number;
    oldText: string;
    newText: string;
    task: ParsedSpecTaskLine;
}

const TASK_LINE_PATTERN = /^(\s*)- \[([ xX~-])\] (.+)$/;

export function parseSpecTaskLine(line: string): ParsedSpecTaskLine | undefined {
    const match = line.match(TASK_LINE_PATTERN);
    if (!match) {
        return undefined;
    }

    const marker = match[2];
    let status: SpecTaskStatus;
    if (marker === ' ') {
        status = 'pending';
    } else if (marker.toLowerCase() === 'x') {
        status = 'completed';
    } else {
        status = 'inProgress';
    }

    return {
        indentation: match[1],
        marker,
        status,
        description: match[3]
    };
}

export function replaceSpecTaskStatus(line: string, status: SpecTaskStatus): string | undefined {
    const task = parseSpecTaskLine(line);
    if (!task) {
        return undefined;
    }

    const marker = status === 'pending'
        ? ' '
        : status === 'completed'
            ? 'x'
            : '-';

    return `${task.indentation}- [${marker}] ${task.description}`;
}

export function buildSpecTaskStatusUpdates(lines: readonly string[], lineNumber: number, status: SpecTaskStatus): SpecTaskStatusUpdate[] {
    if (lineNumber < 0 || lineNumber >= lines.length) {
        return [];
    }

    const task = parseSpecTaskLine(lines[lineNumber]);
    if (!task) {
        return [];
    }

    const workingLines = [...lines];
    const updates: SpecTaskStatusUpdate[] = [];
    addStatusUpdate(workingLines, updates, lineNumber, status);

    if (status === 'completed') {
        addCompletedParentUpdates(workingLines, updates, lineNumber);
    }

    return updates;
}

export function hasChildSpecTasks(lines: readonly string[], lineNumber: number): boolean {
    const task = parseSpecTaskLine(lines[lineNumber]);
    if (!task) {
        return false;
    }

    const taskHierarchy = getTaskHierarchy(task);
    for (let i = lineNumber + 1; i < lines.length; i++) {
        const candidate = parseSpecTaskLine(lines[i]);
        if (!candidate) {
            continue;
        }

        return isDescendantTask(taskHierarchy, getTaskHierarchy(candidate));
    }

    return false;
}

function addCompletedParentUpdates(workingLines: string[], updates: SpecTaskStatusUpdate[], completedLineNumber: number): void {
    let currentLineNumber = completedLineNumber;

    while (true) {
        const parentLineNumber = findParentTaskLine(workingLines, currentLineNumber);
        if (parentLineNumber === undefined) {
            return;
        }

        const parentTask = parseSpecTaskLine(workingLines[parentLineNumber]);
        if (!parentTask) {
            return;
        }

        if (parentTask.status !== 'completed') {
            if (!areAllDescendantTasksCompleted(workingLines, parentLineNumber)) {
                return;
            }

            addStatusUpdate(workingLines, updates, parentLineNumber, 'completed');
        }

        currentLineNumber = parentLineNumber;
    }
}

function addStatusUpdate(workingLines: string[], updates: SpecTaskStatusUpdate[], lineNumber: number, status: SpecTaskStatus): void {
    const oldText = workingLines[lineNumber];
    const task = parseSpecTaskLine(oldText);
    const newText = replaceSpecTaskStatus(oldText, status);
    if (!task || !newText) {
        return;
    }

    workingLines[lineNumber] = newText;
    if (newText === oldText || updates.some(update => update.lineNumber === lineNumber)) {
        return;
    }

    updates.push({
        lineNumber,
        oldText,
        newText,
        task
    });
}

function findParentTaskLine(lines: readonly string[], lineNumber: number): number | undefined {
    const task = parseSpecTaskLine(lines[lineNumber]);
    if (!task) {
        return undefined;
    }

    const taskHierarchy = getTaskHierarchy(task);
    for (let i = lineNumber - 1; i >= 0; i--) {
        const candidate = parseSpecTaskLine(lines[i]);
        if (!candidate) {
            continue;
        }

        if (isAncestorTask(getTaskHierarchy(candidate), taskHierarchy)) {
            return i;
        }
    }

    return undefined;
}

function areAllDescendantTasksCompleted(lines: readonly string[], lineNumber: number): boolean {
    const task = parseSpecTaskLine(lines[lineNumber]);
    if (!task) {
        return false;
    }

    const taskHierarchy = getTaskHierarchy(task);
    let hasDescendant = false;
    for (let i = lineNumber + 1; i < lines.length; i++) {
        const candidate = parseSpecTaskLine(lines[i]);
        if (!candidate) {
            continue;
        }

        if (!isDescendantTask(taskHierarchy, getTaskHierarchy(candidate))) {
            break;
        }

        hasDescendant = true;
        if (candidate.status !== 'completed') {
            return false;
        }
    }

    return hasDescendant;
}

function indentationWidth(indentation: string): number {
    return indentation.replace(/\t/g, '    ').length;
}

interface TaskHierarchy {
    indentationWidth: number;
    numbering?: number[];
}

function getTaskHierarchy(task: ParsedSpecTaskLine): TaskHierarchy {
    return {
        indentationWidth: indentationWidth(task.indentation),
        numbering: parseTaskNumbering(task.description)
    };
}

function parseTaskNumbering(description: string): number[] | undefined {
    const match = description.trim().match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+/);
    if (!match) {
        return undefined;
    }

    return match[1].split('.').map(segment => Number(segment));
}

function isAncestorTask(candidate: TaskHierarchy, task: TaskHierarchy): boolean {
    if (candidate.numbering && task.numbering) {
        return isNumberingPrefix(candidate.numbering, task.numbering);
    }

    return candidate.indentationWidth < task.indentationWidth;
}

function isDescendantTask(parent: TaskHierarchy, candidate: TaskHierarchy): boolean {
    if (parent.numbering && candidate.numbering) {
        return isNumberingPrefix(parent.numbering, candidate.numbering);
    }

    return candidate.indentationWidth > parent.indentationWidth;
}

function isNumberingPrefix(parent: number[], candidate: number[]): boolean {
    return parent.length < candidate.length && parent.every((segment, index) => candidate[index] === segment);
}
