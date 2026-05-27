import * as vscode from 'vscode';
import { IterationManager, IterationMode, IterationRecord } from '../features/iteration/iterationManager';
import { IterationExplorerProvider } from '../providers/iterationExplorerProvider';
import { localize } from '../utils/localization';

export interface RegisterIterationCommandsOptions {
    context: vscode.ExtensionContext;
    iterationManager: IterationManager;
    iterationExplorer: IterationExplorerProvider;
    createSpecFromDescription?: (description: string) => Promise<void>;
    outputChannel: vscode.OutputChannel;
}

export function registerIterationCommands(options: RegisterIterationCommandsOptions): void {
    const {
        context,
        iterationManager,
        iterationExplorer,
        createSpecFromDescription,
        outputChannel
    } = options;

    const startIteration = async (mode?: IterationMode): Promise<void> => {
        try {
            const record = await iterationManager.start({ mode });
            if (record) {
                iterationExplorer.refresh();
            }
        } catch (error) {
            outputChannel.appendLine(`[Iteration] Failed to start iteration: ${error}`);
            vscode.window.showErrorMessage(`Failed to start iteration: ${error}`);
        }
    };

    const openRecordFile = async (
        record: IterationRecord | undefined,
        open: (record: IterationRecord) => Promise<void>
    ): Promise<void> => {
        const selected = record ?? await selectRecentIteration(iterationManager);
        if (!selected) {
            return;
        }

        await open(selected);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('autocode.iteration.start', () => startIteration()),
        vscode.commands.registerCommand('autocode.iteration.ask', () => startIteration('ask')),
        vscode.commands.registerCommand('autocode.iteration.edit', () => startIteration('edit')),
        vscode.commands.registerCommand('autocode.iteration.document', () => startIteration('document')),
        vscode.commands.registerCommand('autocode.iteration.refresh', () => iterationExplorer.refresh()),
        vscode.commands.registerCommand('autocode.iteration.openRecord', async (record?: IterationRecord) => {
            await openRecordFile(record, item => iterationManager.openRecord(item));
        }),
        vscode.commands.registerCommand('autocode.iteration.openPrompt', async (record?: IterationRecord) => {
            await openRecordFile(record, item => iterationManager.openPrompt(item));
        }),
        vscode.commands.registerCommand('autocode.iteration.openSummary', async (record?: IterationRecord) => {
            await openRecordFile(record, item => iterationManager.openSummary(item));
        }),
        vscode.commands.registerCommand('autocode.iteration.continue', async (record?: IterationRecord) => {
            const selected = record ?? await selectRecentIteration(iterationManager);
            if (!selected) {
                return;
            }

            const continuedRecord = await iterationManager.continue(selected);
            if (continuedRecord) {
                iterationExplorer.refresh();
            }
        }),
        vscode.commands.registerCommand('autocode.iteration.convertToSpec', async (record?: IterationRecord) => {
            if (!createSpecFromDescription) {
                vscode.window.showWarningMessage(localize(
                    'Convert Iteration to Spec is unavailable in this AutoCode session.',
                    '当前 AutoCode 会话无法把迭代转换为 Spec。'
                ));
                return;
            }

            const selected = record ?? await selectRecentIteration(iterationManager);
            if (!selected) {
                return;
            }

            const description = await iterationManager.buildSpecDescription(selected);
            await createSpecFromDescription(description);
        })
    );
}

async function selectRecentIteration(iterationManager: IterationManager): Promise<IterationRecord | undefined> {
    const records = await iterationManager.listRecent(20);
    if (records.length === 0) {
        vscode.window.showInformationMessage(localize(
            'No recent iteration sessions were found.',
            '没有找到最近的迭代会话。'
        ));
        return undefined;
    }

    const selected = await vscode.window.showQuickPick(records.map(record => ({
        label: record.title,
        description: record.mode,
        detail: record.startedAt,
        record
    })), {
        placeHolder: localize('Select an iteration session', '选择迭代会话')
    });

    return selected?.record;
}
