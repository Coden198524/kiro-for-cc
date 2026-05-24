import { parseSpecTaskLine, replaceSpecTaskStatus } from '../../../../src/features/spec/taskStatus';

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
});
