import * as vscode from 'vscode';
import { IterationExplorerProvider } from '../../../src/providers/iterationExplorerProvider';
import { IterationRecord } from '../../../src/features/iteration/iterationManager';

jest.mock('vscode');

describe('IterationExplorerProvider', () => {
    test('shows iteration actions and recent records', async () => {
        const record: IterationRecord = {
            id: 'iteration-1',
            title: 'Edit / Fix: repair task queue',
            mode: 'edit',
            description: 'repair task queue',
            workspacePath: '/mock/workspace',
            promptPath: '/mock/workspace/.autocode/iterations/iteration-1.prompt.md',
            summaryPath: '/mock/workspace/.autocode/iterations/iteration-1.summary.md',
            recordPath: '/mock/workspace/.autocode/iterations/iteration-1.json',
            provider: 'Codex',
            activeFilePath: '/mock/workspace/src/features/spec/taskQueueController.ts',
            startedAt: '2026-05-27T00:00:00.000Z'
        };
        const manager = {
            listRecent: jest.fn(async () => [record])
        };
        const provider = new IterationExplorerProvider(manager as any);

        const items = await provider.getChildren();
        const recordItem = items.find(item => item.record === record)!;

        expect(items.slice(0, 4).map(item => item.label)).toEqual([
            'Start Iteration',
            'Ask / Analyze',
            'Edit / Fix',
            'Generate Document'
        ]);
        expect(recordItem.contextValue).toBe('iteration-record');
        expect(recordItem.description).toBe('Edit');
        expect(recordItem.command?.command).toBe('autocode.iteration.openSummary');
        expect(recordItem.iconPath).toEqual(new vscode.ThemeIcon('tools'));
    });
});
