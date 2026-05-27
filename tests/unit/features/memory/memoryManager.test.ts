import * as vscode from 'vscode';
import * as path from 'path';
import { MemoryManager } from '../../../../src/features/memory/memoryManager';
import { ConfigManager } from '../../../../src/utils/configManager';

jest.mock('vscode');

describe('MemoryManager', () => {
    let files: Map<string, Buffer>;
    let memoryManager: MemoryManager;

    beforeEach(() => {
        jest.clearAllMocks();
        (ConfigManager as any).instance = undefined;
        files = new Map();
        (vscode.Uri as any).file = jest.fn((filePath: string) => ({
            fsPath: filePath,
            path: filePath,
            scheme: 'file'
        }));

        (vscode.workspace as any).workspaceFolders = [{
            uri: vscode.Uri.file('/mock/workspace'),
            name: 'mock-workspace',
            index: 0
        }];
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            inspect: jest.fn(() => undefined),
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue)
        });
        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(async (uri: vscode.Uri, content: Uint8Array) => {
            files.set(normalize(uri.fsPath), Buffer.from(content));
        });
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            const content = files.get(normalize(uri.fsPath));
            if (!content) {
                throw new Error(`missing ${uri.fsPath}`);
            }
            return content;
        });
        (vscode.workspace.fs.stat as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            if (!files.has(normalize(uri.fsPath))) {
                throw new Error(`missing ${uri.fsPath}`);
            }
            return { type: vscode.FileType.File };
        });
        (vscode.workspace.fs.readDirectory as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            const dir = normalize(uri.fsPath);
            const entries = new Map<string, vscode.FileType>();
            for (const filePath of files.keys()) {
                if (!filePath.startsWith(`${dir}/`)) {
                    continue;
                }
                const rest = filePath.slice(dir.length + 1);
                const first = rest.split('/')[0];
                entries.set(first, rest.includes('/') ? vscode.FileType.Directory : vscode.FileType.File);
            }
            if (entries.size === 0) {
                throw new Error(`missing ${uri.fsPath}`);
            }
            return [...entries.entries()];
        });

        memoryManager = new MemoryManager({
            subscriptions: [],
            globalStorageUri: vscode.Uri.file('/mock/global')
        } as unknown as vscode.ExtensionContext, vscode.window.createOutputChannel('test'));
    });

    test('writes project memory as JSONL and retrieves relevant prompt context', async () => {
        await memoryManager.addMemory({
            scope: 'project',
            type: 'fact',
            text: 'StartAllTasks must continue only after verification passes.',
            tags: ['StartAllTasks', 'verification'],
            confidence: 0.95
        });

        const context = await memoryManager.buildPromptContext({
            query: 'StartAllTasks verification flow'
        });

        expect(context).toContain('StartAllTasks must continue only after verification passes.');
        expect(context).toContain('Priority order: current user request');
        expect(files.has(normalize('/mock/workspace/.autocode/memory/project/facts.jsonl'))).toBe(true);
    });

    test('stores user preferences outside the workspace and can forget them', async () => {
        const record = await memoryManager.addMemory({
            scope: 'user',
            type: 'preference',
            text: 'Prefer Chinese for task summaries.',
            tags: ['preference'],
            confidence: 1
        });

        expect(record).toBeTruthy();
        expect(files.has(normalize('/mock/global/memory/user/preferences.jsonl'))).toBe(true);

        const forgotten = await memoryManager.forgetMemory(record!);
        const context = await memoryManager.buildPromptContext({
            query: 'Chinese summaries'
        });

        expect(forgotten).toBe(true);
        expect(context).not.toContain('Prefer Chinese for task summaries.');
    });

    test('records verified task completion in the spec memory directory', async () => {
        await memoryManager.recordTaskCompletion({
            taskFilePath: '/mock/workspace/.autocode/specs/demo/tasks.md',
            lineNumber: 3,
            taskDescription: '2. Implement task queue memory',
            verified: true,
            summary: 'Focused tests passed.'
        });

        const memoryPath = normalize('/mock/workspace/.autocode/specs/demo/memory/verification.jsonl');
        expect(files.get(memoryPath)?.toString()).toContain('Implement task queue memory');
        expect(files.get(memoryPath)?.toString()).toContain('Focused tests passed.');
    });

    test('deduplicates exact memory records by fingerprint', async () => {
        const first = await memoryManager.addMemory({
            scope: 'project',
            type: 'fact',
            text: 'Use existing SpecManager patterns.',
            tags: ['SpecManager'],
            confidence: 0.9
        });
        const duplicate = await memoryManager.addMemory({
            scope: 'project',
            type: 'fact',
            text: 'Use existing SpecManager patterns.',
            tags: ['SpecManager'],
            confidence: 0.9
        });

        expect(duplicate?.id).toBe(first?.id);
        const memoryPath = normalize('/mock/workspace/.autocode/memory/project/facts.jsonl');
        expect(files.get(memoryPath)?.toString().trim().split(/\r?\n/)).toHaveLength(1);
    });

    test('only supersedes same-subject source updates instead of shared-tag records', async () => {
        const first = await memoryManager.addMemory({
            scope: 'project',
            type: 'decision',
            text: 'Queue state is stored in task-queue.json.',
            source: { kind: 'file', path: '/mock/workspace/src/queue.ts' },
            tags: ['queue'],
            confidence: 0.8
        });
        await memoryManager.addMemory({
            scope: 'project',
            type: 'decision',
            text: 'Queue state is persisted in task-queue.json with a run id.',
            source: { kind: 'file', path: '/mock/workspace/src/queue.ts' },
            tags: ['queue'],
            confidence: 0.9
        });
        await memoryManager.addMemory({
            scope: 'project',
            type: 'decision',
            text: 'Queue UI belongs in the Current Work panel.',
            tags: ['queue'],
            confidence: 0.9
        });

        const memoryPath = normalize('/mock/workspace/.autocode/memory/project/decisions.jsonl');
        const records = files.get(memoryPath)!.toString().trim().split(/\r?\n/).map(line => JSON.parse(line));
        expect(records.find(record => record.id === first?.id).status).toBe('superseded');
        expect(records.filter(record => record.status === 'active')).toHaveLength(2);
    });

    test('marks opposing same-subject memories as conflicts instead of overwriting them', async () => {
        await memoryManager.addMemory({
            scope: 'project',
            type: 'preference',
            text: 'Use strict verification for task queues.',
            tags: ['verification'],
            subject: 'task-verification',
            confidence: 0.9
        });
        await memoryManager.addMemory({
            scope: 'project',
            type: 'preference',
            text: 'Do not use strict verification for task queues.',
            tags: ['verification'],
            subject: 'task-verification',
            confidence: 0.9
        });

        const memoryPath = normalize('/mock/workspace/.autocode/memory/project/facts.jsonl');
        const records = files.get(memoryPath)!.toString().trim().split(/\r?\n/).map(line => JSON.parse(line));
        expect(records.map(record => record.status)).toEqual(['conflict', 'conflict']);
        expect(records[0].conflictWith).toEqual([records[1].id]);
        expect(records[1].conflictWith).toEqual([records[0].id]);
    });

    test('ranks preferences and pitfalls above noisy session summaries', async () => {
        writeJsonl('/mock/workspace/.autocode/memory/sessions/sessions.jsonl', [
            createMemoryRecord('session-1', 'session', 'summary', 'queue queue queue queue queue failure happened once', {
                createdAt: '2020-01-01T00:00:00.000Z',
                confidence: 0.7
            })
        ]);
        writeJsonl('/mock/global/memory/user/preferences.jsonl', [
            createMemoryRecord('preference-1', 'user', 'preference', 'Prefer Chinese summaries when discussing queue failures.', {
                createdAt: new Date().toISOString(),
                tags: ['queue', 'failure', 'preference'],
                confidence: 1
            })
        ]);
        writeJsonl('/mock/workspace/.autocode/memory/project/pitfalls.jsonl', [
            createMemoryRecord('pitfall-1', 'project', 'pitfall', 'Queue failure often comes from stale completion signals.', {
                createdAt: new Date().toISOString(),
                tags: ['queue', 'failure'],
                confidence: 0.9
            })
        ]);

        const records = await memoryManager.search({
            query: 'queue failure language preference',
            maxItems: 3
        });

        expect(records.map(record => record.id)).toEqual([
            'preference-1',
            'pitfall-1',
            'session-1'
        ]);
    });

    test('boosts memories from the current spec and current file context', async () => {
        writeJsonl('/mock/workspace/.autocode/specs/demo/memory/verification.jsonl', [
            createMemoryRecord('demo-task', 'task', 'verification', 'Queue verification passed for the demo spec.', {
                createdAt: new Date().toISOString(),
                source: { kind: 'verification', path: '/mock/workspace/.autocode/specs/demo/tasks.md' },
                tags: ['queue', 'verification'],
                confidence: 0.9
            })
        ]);
        writeJsonl('/mock/workspace/.autocode/memory/project/facts.jsonl', [
            createMemoryRecord('project-fact', 'project', 'fact', 'Queue verification passed as a general project note.', {
                createdAt: new Date().toISOString(),
                source: { kind: 'file', path: '/mock/workspace/src/queue.ts' },
                tags: ['queue', 'verification'],
                confidence: 0.9
            })
        ]);

        const records = await memoryManager.search({
            query: 'queue verification',
            specFilePath: '/mock/workspace/.autocode/specs/demo/tasks.md',
            currentFilePath: '/mock/workspace/.autocode/specs/demo/tasks.md',
            maxItems: 2
        });

        expect(records.map(record => record.id)).toEqual(['demo-task', 'project-fact']);
    });

    test('keeps generated memory context within the configured prompt budget', async () => {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            inspect: jest.fn((key: string) => key === 'memory.maxPromptChars'
                ? { workspaceValue: 1000 }
                : undefined),
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue)
        });
        await memoryManager.addMemory({
            scope: 'project',
            type: 'fact',
            text: `Queue detail ${'x'.repeat(1400)}`,
            tags: ['queue'],
            confidence: 0.9
        });
        await memoryManager.addMemory({
            scope: 'project',
            type: 'fact',
            text: `Queue secondary detail ${'y'.repeat(1400)}`,
            tags: ['queue'],
            confidence: 0.8
        });

        const context = await memoryManager.buildPromptContext({
            query: 'queue detail'
        });

        expect(context.length).toBeLessThanOrEqual(1000);
        expect(context).toContain('[memory truncated]');
        expect(context).toContain('omitted');
    });

    function normalize(filePath: string): string {
        return path.normalize(filePath).replace(/\\/g, '/');
    }

    function writeJsonl(filePath: string, records: unknown[]): void {
        files.set(normalize(filePath), Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n'));
    }

    function createMemoryRecord(
        id: string,
        scope: string,
        type: string,
        text: string,
        overrides: Record<string, unknown> = {}
    ): Record<string, unknown> {
        return {
            id,
            scope,
            type,
            text,
            confidence: 0.8,
            createdAt: '2026-05-27T00:00:00.000Z',
            status: 'active',
            ...overrides
        };
    }
});
