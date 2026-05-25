import { analyzeTaskPlanQuality, formatTaskPlanQualityIssue } from '../../../../src/features/spec/taskPlanQuality';

describe('task plan quality analysis', () => {
    test('accepts leaf tasks with complete execution metadata', () => {
        const report = analyzeTaskPlanQuality([
            '# Implementation Plan',
            '- [ ] 1. Build task executor',
            '  - Implement the core executor',
            '  - _Files: src/executor.ts, tests/executor.test.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.1, 2.3_',
            '  - _Verify: npm test -- executor.test.ts_',
            '  - _Done when: executor starts one task and reports completion_',
            '- [ ] 2. Add queue integration',
            '  - Wire executor into queue flow',
            '  - _Files: src/queue.ts, tests/queue.test.ts_',
            '  - _Depends on: 1_',
            '  - _Requirements: 2.1_',
            '  - _Verify: npm test -- queue.test.ts_',
            '  - _Done when: queued tasks run after dependencies complete_'
        ]);

        expect(report).toMatchObject({
            taskCount: 2,
            leafTaskCount: 2,
            issueCount: 0,
            errorCount: 0,
            warningCount: 0
        });
    });

    test('reports missing required metadata on leaf tasks', () => {
        const report = analyzeTaskPlanQuality([
            '- [ ] 1. Implement feature',
            '  - Write the implementation',
            '  - _Files: src/feature.ts_',
            '  - _Depends on: none_'
        ]);

        expect(report.errorCount).toBe(3);
        expect(report.issues.map(item => item.message)).toEqual([
            'Leaf task is missing _Requirements: ..._ metadata.',
            'Leaf task is missing _Verify: ..._ metadata.',
            'Leaf task is missing _Done When: ..._ metadata.'
        ]);
        expect(formatTaskPlanQualityIssue(report.issues[0])).toContain('[error] line 1');
    });

    test('reports unknown dependencies, parent dependencies, and cycles', () => {
        const report = analyzeTaskPlanQuality([
            '- [ ] 1. Parent task',
            '- [ ] 1.1 First child',
            '  - _Files: src/first.ts_',
            '  - _Depends on: 1.2, 3_',
            '  - _Requirements: 1.1_',
            '  - _Verify: npm test -- first.test.ts_',
            '  - _Done when: first child is complete_',
            '- [ ] 1.2 Second child',
            '  - _Files: src/second.ts_',
            '  - _Depends on: 1.1_',
            '  - _Requirements: 1.2_',
            '  - _Verify: npm test -- second.test.ts_',
            '  - _Done when: second child is complete_',
            '- [ ] 2. Third child',
            '  - _Files: src/third.ts_',
            '  - _Depends on: 1_',
            '  - _Requirements: 2.1_',
            '  - _Verify: npm test -- third.test.ts_',
            '  - _Done when: third child is complete_'
        ]);

        expect(report.errorCount).toBe(2);
        expect(report.warningCount).toBe(1);
        expect(report.issues.map(item => item.message)).toEqual(expect.arrayContaining([
            'Task 1.1 depends on unknown task 3.',
            'Task 2 depends on parent task 1; depend on leaf task ids instead.',
            'Task dependency graph contains a cycle: 1.1 -> 1.2 -> 1.1.'
        ]));
    });
});
