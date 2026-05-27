import * as vscode from 'vscode';
import { registerSpecTaskCodeLens } from '../../../src/providers/specTaskCodeLensRegistration';

jest.mock('vscode');

describe('registerSpecTaskCodeLens', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        (vscode.Uri as any).file = (filePath: string) => ({
            fsPath: filePath,
            path: filePath,
            scheme: 'file'
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('refreshes task CodeLens when queue state files change', async () => {
        jest.useFakeTimers();
        const subscriptions: vscode.Disposable[] = [];
        const watchers: Array<{
            pattern: string;
            create?: (uri: vscode.Uri) => void;
            change?: (uri: vscode.Uri) => void;
            delete?: (uri: vscode.Uri) => void;
            dispose: jest.Mock;
        }> = [];
        const registeredProviders: any[] = [];
        const outputChannel = vscode.window.createOutputChannel('test');
        const configManager = {
            loadSettings: jest.fn(async () => undefined),
            getPath: jest.fn(() => '.autocode/specs')
        };

        (vscode.languages.registerCodeLensProvider as jest.Mock).mockImplementation((_selector, provider) => {
            registeredProviders.push(provider);
            return { dispose: jest.fn() };
        });
        (vscode.workspace.createFileSystemWatcher as jest.Mock).mockImplementation((pattern: string) => {
            const watcher: {
                pattern: string;
                create?: (uri: vscode.Uri) => void;
                change?: (uri: vscode.Uri) => void;
                delete?: (uri: vscode.Uri) => void;
                dispose: jest.Mock;
                onDidCreate: jest.Mock;
                onDidChange: jest.Mock;
                onDidDelete: jest.Mock;
            } = {
                pattern,
                dispose: jest.fn(),
                onDidCreate: jest.fn((handler) => {
                    watcher.create = handler;
                }),
                onDidChange: jest.fn((handler) => {
                    watcher.change = handler;
                }),
                onDidDelete: jest.fn((handler) => {
                    watcher.delete = handler;
                })
            };
            watchers.push(watcher);
            return watcher;
        });

        await registerSpecTaskCodeLens(
            { subscriptions } as unknown as vscode.ExtensionContext,
            configManager as any,
            outputChannel
        );
        const provider = registeredProviders[0];
        const refresh = jest.spyOn(provider, 'refresh');

        expect(watchers.map(watcher => watcher.pattern)).toEqual([
            '**/.autocode/specs/*/.autocode/task-queue.json',
            '**/.autocode/specs/*/.autocode/task-queue.lock',
            '**/.autocode/specs/*/.autocode/task-completion-*.json'
        ]);

        const queueUri = vscode.Uri.file('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.json');
        const lockUri = vscode.Uri.file('/mock/workspace/.autocode/specs/demo/.autocode/task-queue.lock');
        expect(queueUri.fsPath).toContain('task-queue.json');
        watchers[0].change?.(queueUri);
        watchers[1].create?.(lockUri);
        await jest.advanceTimersByTimeAsync(249);
        expect(refresh).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('task-queue.json'));
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('task-queue.lock'));
    });
});
