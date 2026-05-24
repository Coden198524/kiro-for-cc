export type SpecTaskStatus = 'pending' | 'inProgress' | 'completed';

export interface ParsedSpecTaskLine {
    indentation: string;
    marker: string;
    status: SpecTaskStatus;
    description: string;
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
