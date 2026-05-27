import * as vscode from 'vscode';
import { registerIterationCommands } from '../../../src/commands/iterationCommands';

jest.mock('vscode');

describe('registerIterationCommands', () => {
    let commands: Map<string, (...args: any[]) => Promise<void>>;
    let iterationManager: any;
    let iterationExplorer: any;
    let createSpecFromDescription: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        commands = new Map();
        iterationManager = {
            start: jest.fn(async () => ({ id: 'iteration-1' })),
            listRecent: jest.fn(async () => []),
            openRecord: jest.fn(),
            openPrompt: jest.fn(),
            openSummary: jest.fn(),
            buildSpecDescription: jest.fn(async () => 'spec seed'),
            continue: jest.fn(async () => ({ id: 'iteration-2' }))
        };
        iterationExplorer = {
            refresh: jest.fn()
        };
        createSpecFromDescription = jest.fn();
        (vscode.commands.registerCommand as jest.Mock).mockImplementation((command: string, callback: (...args: any[]) => Promise<void>) => {
            commands.set(command, callback);
            return { dispose: jest.fn() };
        });

        registerIterationCommands({
            context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
            iterationManager,
            iterationExplorer,
            createSpecFromDescription,
            outputChannel: vscode.window.createOutputChannel('test')
        });
    });

    test('starts direct edit iterations and refreshes the explorer', async () => {
        await commands.get('autocode.iteration.edit')!();

        expect(iterationManager.start).toHaveBeenCalledWith({ mode: 'edit' });
        expect(iterationExplorer.refresh).toHaveBeenCalledTimes(1);
    });

    test('opens a selected prompt from recent iterations', async () => {
        const record = {
            id: 'iteration-1',
            title: 'Ask / Analyze: explain queue',
            mode: 'ask',
            startedAt: '2026-05-27T00:00:00.000Z'
        };
        iterationManager.listRecent.mockResolvedValue([record]);
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            label: record.title,
            record
        });

        await commands.get('autocode.iteration.openPrompt')!();

        expect(vscode.window.showQuickPick).toHaveBeenCalled();
        expect(iterationManager.openPrompt).toHaveBeenCalledWith(record);
    });

    test('converts a recent iteration to a spec seed', async () => {
        const record = {
            id: 'iteration-1',
            title: 'Edit / Fix: fix queue',
            mode: 'edit',
            startedAt: '2026-05-27T00:00:00.000Z'
        };
        iterationManager.listRecent.mockResolvedValue([record]);
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            label: record.title,
            record
        });

        await commands.get('autocode.iteration.convertToSpec')!();

        expect(iterationManager.buildSpecDescription).toHaveBeenCalledWith(record);
        expect(createSpecFromDescription).toHaveBeenCalledWith('spec seed');
    });

    test('continues a selected recent iteration and refreshes explorer', async () => {
        const record = {
            id: 'iteration-1',
            title: 'Ask / Analyze: queue question',
            mode: 'ask',
            startedAt: '2026-05-27T00:00:00.000Z'
        };
        iterationManager.listRecent.mockResolvedValue([record]);
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            label: record.title,
            record
        });

        await commands.get('autocode.iteration.continue')!();

        expect(iterationManager.continue).toHaveBeenCalledWith(record);
        expect(iterationExplorer.refresh).toHaveBeenCalledTimes(1);
    });
});
