import * as vscode from 'vscode';
import { SpecTaskCodeLensProvider } from '../../../src/providers/specTaskCodeLensProvider';
import { ConfigManager } from '../../../src/utils/configManager';

describe('SpecTaskCodeLensProvider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (ConfigManager as any).instance = undefined;
        (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error('missing settings'));
    });

    test('shows start, resume, and mark done actions based on persisted task state', async () => {
        const provider = new SpecTaskCodeLensProvider();
        await Promise.resolve();

        const document = createDocument([
            '# Implementation Plan',
            '- [ ] 1. Start me',
            '- [-] 2. Continue me',
            '- [~] 3. Continue me too',
            '- [x] 4. Done'
        ].join('\n'));

        const lenses = await provider.provideCodeLenses(document, {} as any) as vscode.CodeLens[];
        const commands = lenses.map(lens => (lens as any).command);

        expect(commands.map(command => command?.title)).toEqual([
            'Start All Tasks (3)',
            'Start Parallel Tasks (3)',
            'Start Task',
            'Resume Task',
            'Mark Done',
            'View Session',
            'Resume Task',
            'Mark Done',
            'View Session',
            'View Session'
        ]);
        expect(commands[0]?.arguments).toEqual([document.uri]);
        expect(commands[1]?.arguments).toEqual([document.uri]);
        expect(commands[2]?.arguments).toEqual([document.uri, 1, '1. Start me', false]);
        expect(commands[3]?.arguments).toEqual([document.uri, 2, '2. Continue me', true]);
        expect(commands[4]?.arguments).toEqual([document.uri, 2]);
        expect(commands[5]?.arguments).toEqual([document.uri, 2, '2. Continue me']);
        expect(commands[6]?.arguments).toEqual([document.uri, 3, '3. Continue me too', true]);
        expect(commands[9]?.arguments).toEqual([document.uri, 4, '4. Done']);
    });

    test('ignores markdown files outside configured spec tasks documents', async () => {
        const provider = new SpecTaskCodeLensProvider();
        await Promise.resolve();

        const document = createDocument('- [ ] 1. Start me', '/mock/workspace/README.md');

        await expect(provider.provideCodeLenses(document, {} as any)).resolves.toEqual([]);
    });

    test('start all count excludes parent tasks with child tasks', async () => {
        const provider = new SpecTaskCodeLensProvider();
        await Promise.resolve();

        const document = createDocument([
            '# Implementation Plan',
            '- [ ] 1. Parent task',
            '- [ ] 1.1 First child',
            '- [ ] 1.2 Second child',
            '- [ ] 2. Standalone task'
        ].join('\n'));

        const lenses = await provider.provideCodeLenses(document, {} as any) as vscode.CodeLens[];
        const commands = lenses.map(lens => (lens as any).command);

        expect(commands[0]?.title).toBe('Start All Tasks (3)');
        expect(commands[1]?.title).toBe('Start Parallel Tasks (3)');
    });

    test('shows persisted auto queue recovery actions at the top of tasks documents', async () => {
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from(JSON.stringify({
            version: 1,
            taskFilePath: '/mock/workspace/.autocode/specs/demo/tasks.md',
            commandId: 'autocode.spec.implAllTasks',
            status: 'paused',
            startedAt: '2026-05-27T00:00:00.000Z',
            updatedAt: '2026-05-27T00:00:00.000Z',
            currentTask: {
                lineNumber: 1,
                taskDescription: '1. Start me'
            },
            pauseReason: 'Verification failed.'
        })));

        const provider = new SpecTaskCodeLensProvider();
        await Promise.resolve();

        const document = createDocument([
            '# Implementation Plan',
            '- [-] 1. Start me'
        ].join('\n'));

        const lenses = await provider.provideCodeLenses(document, {} as any) as vscode.CodeLens[];
        const commands = lenses.map(lens => (lens as any).command);

        expect(commands[0]).toEqual(expect.objectContaining({
            title: 'Resume Auto Queue (paused)',
            command: 'autocode.spec.resumeTaskQueue',
            arguments: [document.uri]
        }));
        expect(commands[1]).toEqual(expect.objectContaining({
            title: 'Clear Auto Queue',
            command: 'autocode.spec.clearTaskQueue',
            arguments: [document.uri]
        }));
    });

    function createDocument(content: string, fileName = '/mock/workspace/.autocode/specs/demo/tasks.md'): vscode.TextDocument {
        return {
            fileName,
            uri: vscode.Uri.file(fileName),
            getText: () => content
        } as any;
    }
});
