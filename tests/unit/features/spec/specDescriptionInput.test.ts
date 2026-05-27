import * as vscode from 'vscode';
import { SpecDescriptionInput } from '../../../../src/features/spec/specDescriptionInput';

jest.mock('vscode');

describe('SpecDescriptionInput', () => {
    let messageHandler: ((message: unknown) => unknown) | undefined;
    let disposeHandler: (() => void) | undefined;
    let panel: any;

    beforeEach(() => {
        jest.clearAllMocks();
        messageHandler = undefined;
        disposeHandler = undefined;
        panel = {
            webview: {
                html: '',
                onDidReceiveMessage: jest.fn((handler: (message: unknown) => void) => {
                    messageHandler = handler;
                    return { dispose: jest.fn() };
                })
            },
            onDidDispose: jest.fn((handler: () => void) => {
                disposeHandler = handler;
                return { dispose: jest.fn() };
            }),
            dispose: jest.fn()
        };
        (vscode.window as any).createWebviewPanel = jest.fn(() => panel);
        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: '/mock/workspace', path: '/mock/workspace', scheme: 'file' },
            name: 'mock-workspace',
            index: 0
        }];
        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
        (vscode.Uri as any).file = jest.fn((filePath: string) => ({
            fsPath: filePath,
            path: filePath,
            scheme: 'file'
        }));
    });

    afterEach(() => {
        delete (vscode.window as any).createWebviewPanel;
    });

    test('renders a large multi-line spec description editor', async () => {
        const resultPromise = SpecDescriptionInput.prompt({
            title: 'Create New Spec',
            prompt: 'Describe the feature',
            placeholder: 'Line one\nLine two'
        });

        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            'autocodeSpecDescriptionInput',
            'Create New Spec',
            vscode.ViewColumn.One,
            expect.objectContaining({
                enableScripts: true,
                retainContextWhenHidden: true
            })
        );
        expect(panel.webview.html).toContain('<textarea');
        expect(panel.webview.html).toContain('min-height: 300px');
        expect(panel.webview.html).toContain('Ctrl+Enter submits');
        expect(panel.webview.html).toContain('Drop files or images here');

        await messageHandler?.({
            command: 'submit',
            text: 'First line\nSecond line'
        });

        await expect(resultPromise).resolves.toBe('First line\nSecond line');
        expect(panel.dispose).toHaveBeenCalled();
    });

    test('falls back to the VS Code input box when webviews are unavailable', async () => {
        delete (vscode.window as any).createWebviewPanel;
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('Short idea');

        const result = await SpecDescriptionInput.prompt({
            title: 'Create New Spec',
            prompt: 'Describe the feature',
            placeholder: 'Enter an idea'
        });

        expect(result).toBe('Short idea');
        expect(vscode.window.showInputBox).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Create New Spec',
            placeHolder: 'Enter an idea'
        }));
    });

    test('returns undefined when the input panel is closed', async () => {
        const resultPromise = SpecDescriptionInput.prompt({
            title: 'Create New Spec',
            prompt: 'Describe the feature',
            placeholder: 'Enter an idea'
        });

        disposeHandler?.();

        await expect(resultPromise).resolves.toBeUndefined();
    });

    test('adds dropped text files and saved image paths to the submitted description', async () => {
        const resultPromise = SpecDescriptionInput.prompt({
            title: 'Create New Spec',
            prompt: 'Describe the feature',
            placeholder: 'Enter an idea'
        });

        await messageHandler?.({
            command: 'submit',
            text: 'Build a dashboard',
            attachments: [
                {
                    kind: 'text',
                    name: 'notes.md',
                    type: 'text/markdown',
                    size: 12,
                    content: '# Notes\nUse filters'
                },
                {
                    kind: 'data',
                    name: 'wireframe.png',
                    type: 'image/png',
                    size: 5,
                    dataUrl: 'data:image/png;base64,aGVsbG8='
                }
            ]
        });

        const result = await resultPromise;
        expect(result).toContain('Build a dashboard');
        expect(result).toContain('## Attached Files');
        expect(result).toContain('### 1. notes.md');
        expect(result).toContain('# Notes\nUse filters');
        expect(result).toContain('### 2. wireframe.png');
        expect(result?.replace(/\\/g, '/')).toContain('Saved path: /mock/workspace/.autocode/spec-input-assets/2-wireframe.png');
        expect(result).toContain('Use this image as visual reference');
        expect(vscode.workspace.fs.createDirectory).toHaveBeenCalled();
        expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
            expect.anything(),
            Buffer.from('hello')
        );
    });
});
