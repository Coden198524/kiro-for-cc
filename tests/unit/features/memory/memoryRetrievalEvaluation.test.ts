import * as path from 'path';
import * as vscode from 'vscode';
import { MemoryManager } from '../../../../src/features/memory/memoryManager';
import { ConfigManager } from '../../../../src/utils/configManager';

jest.mock('vscode');

interface EvaluationCase {
    name: string;
    query: string;
    request: {
        specFilePath?: string;
    };
    expectedTopIds: string[];
    excludedIds: string[];
}

describe('Memory retrieval evaluation set', () => {
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
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            const content = files.get(normalize(uri.fsPath));
            if (!content) {
                throw new Error(`missing ${uri.fsPath}`);
            }
            return content;
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

        seedEvaluationCorpus();
        memoryManager = new MemoryManager({
            subscriptions: [],
            globalStorageUri: vscode.Uri.file('/mock/global')
        } as unknown as vscode.ExtensionContext, vscode.window.createOutputChannel('test'));
    });

    const evaluationCases: EvaluationCase[] = [
        {
            name: 'task queue continuation recalls completion signal and stale queue pitfalls',
            query: 'StartAllTasks next task completion signal stale queue',
            request: {},
            expectedTopIds: ['queue-stale-signal', 'queue-runid-decision'],
            excludedIds: ['memory-filter-ui', 'pending-queue-experiment']
        },
        {
            name: 'memory panel filter query recalls UI memory without queue noise',
            query: 'Memory panel search filter conflict inbox',
            request: {},
            expectedTopIds: ['memory-filter-ui'],
            excludedIds: ['queue-stale-signal', 'pending-queue-experiment']
        },
        {
            name: 'current spec context ranks matching spec archive first',
            query: 'final verification task queue runId',
            request: {
                specFilePath: '/mock/workspace/.autocode/specs/task-queue/tasks.md'
            },
            expectedTopIds: ['task-queue-spec-summary', 'queue-runid-decision'],
            excludedIds: ['memory-filter-ui', 'pending-queue-experiment']
        }
    ];

    for (const evaluationCase of evaluationCases) {
        test(evaluationCase.name, async () => {
            const records = await memoryManager.search({
                query: evaluationCase.query,
                maxItems: 5,
                ...evaluationCase.request
            });
            const ids = records.map(record => record.id);

            expect(ids.slice(0, evaluationCase.expectedTopIds.length)).toEqual(evaluationCase.expectedTopIds);
            for (const excludedId of evaluationCase.excludedIds) {
                expect(ids).not.toContain(excludedId);
            }
        });
    }

    function seedEvaluationCorpus(): void {
        writeJsonl('/mock/workspace/.autocode/memory/project/pitfalls.jsonl', [
            createMemoryRecord(
                'queue-stale-signal',
                'project',
                'pitfall',
                'StartAllTasks can stop after a task if stale completion signals are not reconciled before continuing the next queue item.',
                {
                    tags: ['StartAllTasks', 'completion-signal', 'queue'],
                    confidence: 0.95
                }
            )
        ]);
        writeJsonl('/mock/workspace/.autocode/memory/project/decisions.jsonl', [
            createMemoryRecord(
                'queue-runid-decision',
                'project',
                'decision',
                'Completion signal verification must compare queue runId tokens before marking a task done.',
                {
                    tags: ['runId', 'completion-signal', 'verification'],
                    confidence: 0.95
                }
            ),
            createMemoryRecord(
                'memory-filter-ui',
                'project',
                'decision',
                'Memory panel search supports query filtering, conflict filtering, and review inbox filtering.',
                {
                    tags: ['memory', 'filter', 'conflict', 'inbox'],
                    confidence: 0.9
                }
            )
        ]);
        writeJsonl('/mock/workspace/.autocode/memory/project/facts.jsonl', [
            createMemoryRecord(
                'pending-queue-experiment',
                'project',
                'fact',
                'Experimental queue memory should not be retrieved until it is accepted from the review inbox.',
                {
                    status: 'pending',
                    tags: ['queue', 'memory'],
                    confidence: 1
                }
            )
        ]);
        writeJsonl('/mock/workspace/.autocode/memory/sessions/sessions.jsonl', [
            createMemoryRecord(
                'noisy-session',
                'session',
                'summary',
                'queue queue queue queue old debugging session with partial completion wording',
                {
                    tags: ['queue'],
                    confidence: 0.6
                }
            )
        ]);
        writeJsonl('/mock/workspace/.autocode/specs/task-queue/memory/spec-summary.jsonl', [
            createMemoryRecord(
                'task-queue-spec-summary',
                'spec',
                'summary',
                'Spec task-queue final verification archived npm test for queue runId completion signals.',
                {
                    source: {
                        kind: 'spec',
                        path: '/mock/workspace/.autocode/specs/task-queue/tasks.md'
                    },
                    tags: ['spec-archive', 'task-queue', 'runId'],
                    confidence: 0.95
                }
            )
        ]);
    }

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
