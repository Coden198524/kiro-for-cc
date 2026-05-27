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

    function normalize(filePath: string): string {
        return path.normalize(filePath).replace(/\\/g, '/');
    }
});
