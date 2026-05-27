import * as vscode from 'vscode';
import { MemoryExplorerProvider } from '../../../src/providers/memoryExplorerProvider';
import { StoredMemoryRecord } from '../../../src/features/memory/memoryManager';

jest.mock('vscode');

describe('MemoryExplorerProvider', () => {
    test('shows memory groups and records', async () => {
        const record: StoredMemoryRecord = {
            id: 'mem-1',
            scope: 'project',
            type: 'fact',
            text: 'Use existing SpecManager patterns.',
            tags: ['SpecManager'],
            confidence: 0.9,
            createdAt: '2026-05-26T00:00:00.000Z',
            status: 'active',
            storagePath: '/mock/workspace/.autocode/memory/project/facts.jsonl',
            source: {
                kind: 'file',
                path: '/mock/workspace/src/features/spec/specManager.ts'
            }
        };
        const memoryManager = {
            isEnabled: jest.fn(() => true),
            listRecords: jest.fn(async (category?: string) => category === 'project' ? [record] : [])
        };
        const provider = new MemoryExplorerProvider(memoryManager as any);

        const groups = await provider.getChildren();
        const projectItems = await provider.getChildren(groups[0]);

        expect(groups.map(item => item.label)).toEqual([
            'Review Inbox',
            'Project Memory',
            'User Preferences',
            'Spec Memory',
            'Session History',
            'Pitfalls'
        ]);
        expect(projectItems[0].label).toBe('No memory yet');
        const projectRecordItems = await provider.getChildren(groups[1]);
        expect(projectRecordItems[0].label).toBe('Use existing SpecManager patterns.');
        expect(projectRecordItems[0].contextValue).toBe('memory-record');
        expect(projectRecordItems[0].command?.command).toBe('autocode.memory.openSource');
        expect(projectRecordItems[0].iconPath).toEqual(new vscode.ThemeIcon('note'));
    });
});
