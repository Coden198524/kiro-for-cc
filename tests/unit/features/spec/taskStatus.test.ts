import { buildSpecTaskStatusUpdates, hasChildSpecTasks, parseSpecTaskLine, replaceSpecTaskStatus } from '../../../../src/features/spec/taskStatus';

describe('spec task status helpers', () => {
    test('parses pending, in-progress, alternate in-progress, and completed task lines', () => {
        expect(parseSpecTaskLine('- [ ] 1. Implement feature')).toMatchObject({
            status: 'pending',
            description: '1. Implement feature'
        });
        expect(parseSpecTaskLine('  - [-] 1.1 Continue feature')).toMatchObject({
            indentation: '  ',
            status: 'inProgress',
            description: '1.1 Continue feature'
        });
        expect(parseSpecTaskLine('- [~] 2. Resume feature')).toMatchObject({
            status: 'inProgress',
            description: '2. Resume feature'
        });
        expect(parseSpecTaskLine('- [x] 3. Done')).toMatchObject({
            status: 'completed',
            description: '3. Done'
        });
    });

    test('replaces task status while preserving indentation and description', () => {
        expect(replaceSpecTaskStatus('  - [ ] 1. Implement feature', 'inProgress'))
            .toBe('  - [-] 1. Implement feature');
        expect(replaceSpecTaskStatus('  - [-] 1. Implement feature', 'completed'))
            .toBe('  - [x] 1. Implement feature');
        expect(replaceSpecTaskStatus('not a task', 'completed')).toBeUndefined();
    });

    test('marks parent tasks completed when every numbered child task is completed', () => {
        const updates = buildSpecTaskStatusUpdates([
            '- [-] 1. Parent task',
            '- [x] 1.1 First child',
            '- [-] 1.2 Second child',
            '- [-] 2. Other parent'
        ], 2, 'completed');

        expect(updates.map(update => [update.lineNumber, update.newText])).toEqual([
            [2, '- [x] 1.2 Second child'],
            [0, '- [x] 1. Parent task']
        ]);
    });

    test('does not mark parent completed while a child remains unfinished', () => {
        const updates = buildSpecTaskStatusUpdates([
            '- [-] 1. Parent task',
            '- [-] 1.1 First child',
            '- [-] 1.2 Second child'
        ], 2, 'completed');

        expect(updates.map(update => [update.lineNumber, update.newText])).toEqual([
            [2, '- [x] 1.2 Second child']
        ]);
    });

    test('detects child tasks by numbering when indentation is flat', () => {
        const lines = [
            '- [ ] 1. Parent task',
            '- [ ] 1.1 First child',
            '- [ ] 2. Other task'
        ];

        expect(hasChildSpecTasks(lines, 0)).toBe(true);
        expect(hasChildSpecTasks(lines, 1)).toBe(false);
    });
});
