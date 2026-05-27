import * as vscode from 'vscode';
import { SpecExplorerProvider } from '../../../src/providers/specExplorerProvider';

jest.mock('vscode');

describe('SpecExplorerProvider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace as any).workspaceFolders = [{
            uri: vscode.Uri.file('/mock/workspace'),
            name: 'mock-workspace',
            index: 0
        }];
    });

    test('shows fixed Specs action rows before specs so commands are visible without title-bar space', async () => {
        const provider = new SpecExplorerProvider(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.window.createOutputChannel('test')
        );
        provider.setSpecManager({
            getSpecList: jest.fn().mockResolvedValue(['demo-spec']),
            getSpecBasePath: jest.fn().mockResolvedValue('.autocode/specs')
        } as any);

        const children = await provider.getChildren();

        expect(children.map(item => item.label)).toEqual([
            'Initialize Project Context',
            'Create New Spec',
            'Create Spec with Agents',
            'demo-spec'
        ]);
        expect(children[0].command?.command).toBe('autocode.steering.generateInitial');
        expect(children[1].command?.command).toBe('autocode.spec.create');
        expect(children[2].command?.command).toBe('autocode.spec.createWithAgents');
        expect(children[0].iconPath).toEqual(new vscode.ThemeIcon('repo'));
        expect(children[1].iconPath).toEqual(new vscode.ThemeIcon('plus'));
        expect(children[2].iconPath).toEqual(new vscode.ThemeIcon('sparkle'));
    });
});
