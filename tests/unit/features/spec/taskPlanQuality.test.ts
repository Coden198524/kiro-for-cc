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

    test('accepts localized metadata aliases and validates localized dependencies', () => {
        const report = analyzeTaskPlanQuality([
            '- [ ] 1. 初始化核心',
            '  - _文件: src/core.ts, tests/core.test.ts_',
            '  - _依赖: 无_',
            '  - _需求: 1.1_',
            '  - _验证: npm test -- core.test.ts_',
            '  - _完成条件: 核心能力有测试覆盖_',
            '- [ ] 2. 实现功能',
            '  - _文件: src/feature.ts, tests/feature.test.ts_',
            '  - _前置任务: 1, 3_',
            '  - _需求: 2.1_',
            '  - _验证方式: npm test -- feature.test.ts_',
            '  - _完成标准: 功能测试通过_'
        ]);

        expect(report.errorCount).toBe(1);
        expect(report.issues.map(item => item.message)).toEqual([
            'Task 2 depends on unknown task 3.'
        ]);
    });

    test('warns when independent leaf tasks target overlapping file scopes', () => {
        const report = analyzeTaskPlanQuality([
            '- [ ] 1. Build first slice',
            '  - _Files: src/shared.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.1_',
            '  - _Verify: npm test -- shared.test.ts_',
            '  - _Done when: first slice passes_',
            '- [ ] 2. Build second slice',
            '  - _Files: src/shared.ts, tests/shared.test.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.2_',
            '  - _Verify: npm test -- shared.test.ts_',
            '  - _Done when: second slice passes_'
        ]);

        expect(report.errorCount).toBe(0);
        expect(report.warningCount).toBe(1);
        expect(report.issues[0].message).toBe('Tasks 1 and 2 both target src/shared.ts without a dependency; add a dependency or split file scopes before parallel execution.');
    });

    test('allows overlapping file scopes when dependency metadata orders the tasks', () => {
        const report = analyzeTaskPlanQuality([
            '- [ ] 1. Build first slice',
            '  - _Files: src/shared.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.1_',
            '  - _Verify: npm test -- shared.test.ts_',
            '  - _Done when: first slice passes_',
            '- [ ] 2. Build second slice',
            '  - _Files: src/shared.ts, tests/shared.test.ts_',
            '  - _Depends on: 1_',
            '  - _Requirements: 1.2_',
            '  - _Verify: npm test -- shared.test.ts_',
            '  - _Done when: second slice passes_'
        ]);

        expect(report.issueCount).toBe(0);
    });

    test('cross-checks task requirement references against requirements.md coverage', () => {
        const report = analyzeTaskPlanQuality([
            '- [ ] 1. Build first slice',
            '  - _Files: src/first.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.1, 9.9_',
            '  - _Verify: npm test -- first.test.ts_',
            '  - _Done when: first slice passes_',
            '- [ ] 2. Build second slice',
            '  - _Files: src/second.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.2_',
            '  - _Verify: npm test -- second.test.ts_',
            '  - _Done when: second slice passes_'
        ], {
            requirementsText: [
                '# Requirements',
                '## Requirement 1.1',
                'User can start the queue.',
                '## Requirement 1.2',
                'User can resume the queue.',
                '## Requirement 2.1',
                'User can inspect queue state.'
            ].join('\n')
        });

        expect(report.errorCount).toBe(1);
        expect(report.warningCount).toBe(1);
        expect(report.issues.map(item => item.message)).toEqual(expect.arrayContaining([
            'Task 1 references requirement 9.9, but it was not found in requirements.md.',
            'Requirement 2.1 from requirements.md is not covered by any leaf task.'
        ]));
    });

    test('validates verify metadata is actionable', () => {
        const report = analyzeTaskPlanQuality([
            '- [ ] 1. Missing verification',
            '  - _Files: src/feature.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.1_',
            '  - _Verify: TBD_',
            '  - _Done when: feature passes_',
            '- [ ] 2. Vague verification',
            '  - _Files: src/other.ts_',
            '  - _Depends on: none_',
            '  - _Requirements: 1.1_',
            '  - _Verify: run checks_',
            '  - _Done when: checks pass_'
        ]);

        expect(report.errorCount).toBe(1);
        expect(report.warningCount).toBe(1);
        expect(report.issues.map(item => item.message)).toEqual(expect.arrayContaining([
            'Leaf task _Verify:_ metadata must include a concrete command or explicit manual check.',
            'Leaf task _Verify:_ metadata should name a concrete verification command, script, or explicit manual check.'
        ]));
    });
});
