import { hasChildSpecTasks, parseSpecTaskLine } from './taskStatus';

export type TaskPlanQualitySeverity = 'error' | 'warning';

export interface TaskPlanQualityIssue {
    severity: TaskPlanQualitySeverity;
    lineNumber?: number;
    taskId?: string;
    message: string;
}

export interface TaskPlanQualityReport {
    taskCount: number;
    leafTaskCount: number;
    issueCount: number;
    errorCount: number;
    warningCount: number;
    issues: TaskPlanQualityIssue[];
}

interface TaskPlanEntry {
    lineNumber: number;
    taskId?: string;
    description: string;
    detailLines: string[];
    isLeaf: boolean;
    metadata: Map<string, string>;
}

const REQUIRED_LEAF_METADATA = ['files', 'depends on', 'requirements', 'verify', 'done when'];

export function analyzeTaskPlanQuality(lines: readonly string[]): TaskPlanQualityReport {
    const tasks = collectTasks(lines);
    const leafTasks = tasks.filter(task => task.isLeaf);
    const issues: TaskPlanQualityIssue[] = [];
    const taskIds = new Map<string, TaskPlanEntry>();
    const parentTaskIds = new Set(tasks.filter(task => !task.isLeaf).map(task => task.taskId).filter((taskId): taskId is string => Boolean(taskId)));

    for (const task of tasks) {
        if (!task.taskId) {
            issues.push(issue('error', task, 'Task is missing a parseable numeric task id.'));
            continue;
        }

        const existing = taskIds.get(task.taskId);
        if (existing) {
            issues.push(issue('error', task, `Task id ${task.taskId} is duplicated with line ${existing.lineNumber + 1}.`));
            continue;
        }

        taskIds.set(task.taskId, task);
    }

    for (const task of leafTasks) {
        for (const key of REQUIRED_LEAF_METADATA) {
            if (!task.metadata.has(key)) {
                issues.push(issue('error', task, `Leaf task is missing _${formatMetadataKey(key)}: ..._ metadata.`));
            }
        }

        const files = parseCsvMetadata(task.metadata.get('files'));
        if (task.metadata.has('files') && files.length === 0) {
            issues.push(issue('error', task, 'Leaf task _Files:_ metadata must list at least one concrete file or directory scope.'));
        }

        const dependencies = parseDependencyMetadata(task.metadata.get('depends on'));
        for (const dependency of dependencies) {
            if (dependency === task.taskId) {
                issues.push(issue('error', task, `Task ${task.taskId} depends on itself.`));
            } else if (!taskIds.has(dependency)) {
                issues.push(issue('error', task, `Task ${task.taskId} depends on unknown task ${dependency}.`));
            } else if (parentTaskIds.has(dependency)) {
                issues.push(issue('warning', task, `Task ${task.taskId} depends on parent task ${dependency}; depend on leaf task ids instead.`));
            }
        }
    }

    const cycle = findDependencyCycle(leafTasks, taskIds);
    if (cycle) {
        issues.push({
            severity: 'error',
            taskId: cycle[0],
            message: `Task dependency graph contains a cycle: ${cycle.join(' -> ')}.`
        });
    }

    const errorCount = issues.filter(item => item.severity === 'error').length;
    const warningCount = issues.length - errorCount;

    return {
        taskCount: tasks.length,
        leafTaskCount: leafTasks.length,
        issueCount: issues.length,
        errorCount,
        warningCount,
        issues
    };
}

export function formatTaskPlanQualityIssue(issue: TaskPlanQualityIssue): string {
    const location = issue.lineNumber === undefined
        ? issue.taskId ? `task ${issue.taskId}` : 'task plan'
        : `line ${issue.lineNumber + 1}`;
    return `[${issue.severity}] ${location}: ${issue.message}`;
}

function collectTasks(lines: readonly string[]): TaskPlanEntry[] {
    const tasks: TaskPlanEntry[] = [];

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const task = parseSpecTaskLine(lines[lineNumber]);
        if (!task) {
            continue;
        }

        const detailLines = getTaskDetailLines(lines, lineNumber);
        tasks.push({
            lineNumber,
            taskId: parseTaskId(task.description),
            description: task.description,
            detailLines,
            isLeaf: !hasChildSpecTasks(lines, lineNumber),
            metadata: parseMetadata(detailLines)
        });
    }

    return tasks;
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

function parseMetadata(lines: readonly string[]): Map<string, string> {
    const metadata = new Map<string, string>();

    for (const line of lines) {
        const match = line.trim().match(/^(?:[-*]\s*)?_?([A-Za-z][A-Za-z ]+)\s*:\s*(.*?)_?$/);
        if (!match) {
            continue;
        }

        metadata.set(normalizeMetadataKey(match[1]), match[2].trim());
    }

    return metadata;
}

function parseTaskId(description: string): string | undefined {
    return description.trim().match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+/)?.[1];
}

function parseCsvMetadata(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .filter(item => !/^(none|n\/a|na|null|empty|-+)$/i.test(item));
}

function parseDependencyMetadata(value: string | undefined): string[] {
    const normalized = (value ?? '').trim();
    if (!normalized || /^(none|n\/a|na|null|empty|-+)$/i.test(normalized)) {
        return [];
    }

    return [...normalized.matchAll(/\b\d+(?:\.\d+)*\b/g)]
        .map(match => match[0])
        .filter((dependency, index, all) => all.indexOf(dependency) === index);
}

function findDependencyCycle(leafTasks: readonly TaskPlanEntry[], taskIds: Map<string, TaskPlanEntry>): string[] | undefined {
    const leafTaskIds = new Set(leafTasks.map(task => task.taskId).filter((taskId): taskId is string => Boolean(taskId)));
    const visiting: string[] = [];
    const visited = new Set<string>();

    const visit = (taskId: string): string[] | undefined => {
        const cycleStart = visiting.indexOf(taskId);
        if (cycleStart >= 0) {
            return [...visiting.slice(cycleStart), taskId];
        }

        if (visited.has(taskId)) {
            return undefined;
        }

        const task = taskIds.get(taskId);
        if (!task) {
            return undefined;
        }

        visiting.push(taskId);
        for (const dependency of parseDependencyMetadata(task.metadata.get('depends on')).filter(item => leafTaskIds.has(item))) {
            const cycle = visit(dependency);
            if (cycle) {
                return cycle;
            }
        }

        visiting.pop();
        visited.add(taskId);
        return undefined;
    };

    for (const taskId of leafTaskIds) {
        const cycle = visit(taskId);
        if (cycle) {
            return cycle;
        }
    }

    return undefined;
}

function issue(severity: TaskPlanQualitySeverity, task: TaskPlanEntry, message: string): TaskPlanQualityIssue {
    return {
        severity,
        lineNumber: task.lineNumber,
        taskId: task.taskId,
        message
    };
}

function indentationWidth(indentation: string): number {
    return indentation.replace(/\t/g, '    ').length;
}

function normalizeMetadataKey(key: string): string {
    return key.trim().replace(/\s+/g, ' ').toLowerCase();
}

function formatMetadataKey(key: string): string {
    return key.replace(/\b\w/g, char => char.toUpperCase());
}
