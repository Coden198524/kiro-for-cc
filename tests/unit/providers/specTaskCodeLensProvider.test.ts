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

        const lenses = provider.provideCodeLenses(document, {} as any) as vscode.CodeLens[];
        const commands = lenses.map(lens => (lens as any).command);

        expect(commands.map(command => command?.title)).toEqual([
            'Start All Tasks (3)',
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
        expect(commands[1]?.arguments).toEqual([document.uri, 1, '1. Start me', false]);
        expect(commands[2]?.arguments).toEqual([document.uri, 2, '2. Continue me', true]);
        expect(commands[3]?.arguments).toEqual([document.uri, 2]);
        expect(commands[4]?.arguments).toEqual([document.uri, 2, '2. Continue me']);
        expect(commands[5]?.arguments).toEqual([document.uri, 3, '3. Continue me too', true]);
        expect(commands[8]?.arguments).toEqual([document.uri, 4, '4. Done']);
    });

    test('ignores markdown files outside configured spec tasks documents', async () => {
        const provider = new SpecTaskCodeLensProvider();
        await Promise.resolve();

        const document = createDocument('- [ ] 1. Start me', '/mock/workspace/README.md');

        expect(provider.provideCodeLenses(document, {} as any)).toEqual([]);
    });

    function createDocument(content: string, fileName = '/mock/workspace/.autocode/specs/demo/tasks.md'): vscode.TextDocument {
        return {
            fileName,
            uri: vscode.Uri.file(fileName),
            getText: () => content
        } as any;
    }
});
