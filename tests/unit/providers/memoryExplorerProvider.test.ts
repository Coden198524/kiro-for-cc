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

    test('shows filtered memory results when search or category filters are active', async () => {
        const matchingRecord: StoredMemoryRecord = {
            id: 'mem-conflict',
            scope: 'project',
            type: 'decision',
            text: 'Task queue verification must stay strict.',
            tags: ['queue', 'verification'],
            confidence: 0.9,
            createdAt: '2026-05-26T00:00:00.000Z',
            status: 'conflict',
            storagePath: '/mock/workspace/.autocode/memory/project/decisions.jsonl'
        };
        const otherRecord: StoredMemoryRecord = {
            ...matchingRecord,
            id: 'mem-other',
            text: 'Use compact summaries for sessions.',
            tags: ['session'],
            status: 'active'
        };
        const memoryManager = {
            isEnabled: jest.fn(() => true),
            listRecords: jest.fn(async (category?: string) => {
                if (category === 'conflict') {
                    return [matchingRecord];
                }
                return [matchingRecord, otherRecord];
            })
        };
        const provider = new MemoryExplorerProvider(memoryManager as any);

        provider.setFilter({ category: 'conflict', query: 'queue strict' });
        const roots = await provider.getChildren();
        const results = await provider.getChildren(roots[0]);

        expect(roots[0].label).toBe('Filtered Memory');
        expect(roots[0].description).toBe('Conflicts | Query: queue strict');
        expect(results).toHaveLength(1);
        expect(results[0].label).toBe('Task queue verification must stay strict.');
        expect(results[0].iconPath).toEqual(new vscode.ThemeIcon('warning'));
        expect(memoryManager.listRecords).toHaveBeenCalledWith('conflict');

        provider.clearFilter();
        const groups = await provider.getChildren();
        expect(groups.map(item => item.label)).toContain('Project Memory');
    });
});
