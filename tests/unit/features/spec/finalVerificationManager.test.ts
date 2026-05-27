import * as vscode from 'vscode';
import {
    collectFinalVerificationItems,
    FinalVerificationManager,
    formatFinalVerificationReport
} from '../../../../src/features/spec/finalVerificationManager';

jest.mock('vscode');

describe('FinalVerificationManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.Uri as any).file = (filePath: string) => ({
            fsPath: filePath,
            path: filePath,
            scheme: 'file'
        });
        (vscode.workspace as any).workspaceFolders = [{
            uri: vscode.Uri.file('/mock/workspace'),
            name: 'mock-workspace',
            index: 0
        }];
        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    });

    test('collects unique command and manual verification checks from leaf tasks', async () => {
        const items = collectFinalVerificationItems([
            '# Tasks',
            '- [ ] 1. Parent task',
            '- [ ] 1.1 First task',
            '  - _Verify: npm test -- first.test.ts_',
            '- [ ] 1.2 Second task',
            '  - _Verify: npm test -- first.test.ts_',
            '- [ ] 2. Manual task',
            '  - _Verify: Manual: inspect VS Code panel_'
        ]);

        expect(items).toEqual([
            expect.objectContaining({
                lineNumber: 2,
                taskId: '1.1',
                value: 'npm test -- first.test.ts',
                kind: 'command'
            }),
            expect.objectContaining({
                lineNumber: 4,
                taskId: '1.2',
                value: 'npm test -- first.test.ts',
                kind: 'command'
            }),
            expect.objectContaining({
                lineNumber: 6,
                taskId: '2',
                value: 'Manual: inspect VS Code panel',
                kind: 'manual'
            })
        ]);
    });

    test('writes a report and launches command checks in a visible terminal', async () => {
        const terminal = vscode.window.createTerminal('verification');
        (vscode.window.createTerminal as jest.Mock).mockReturnValue(terminal);
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from([
            '# Tasks',
            '- [ ] 1. First task',
            '  - _Verify: npm test -- first.test.ts_',
            '- [ ] 2. Duplicate task',
            '  - _Verify: npm test -- first.test.ts_',
            '- [ ] 3. Build task',
            '  - _Verify: npm run compile_'
        ].join('\n')));
        const memoryManager = {
            recordSpecArchive: jest.fn().mockResolvedValue(undefined)
        };
        const manager = new FinalVerificationManager(vscode.window.createOutputChannel('test'), memoryManager as any);
        const documentUri = vscode.Uri.file('/mock/workspace/.autocode/specs/demo/tasks.md');

        const plan = await manager.run(documentUri);

        expect(plan?.commandItems.map(item => item.value)).toEqual([
            'npm test -- first.test.ts',
            'npm run compile'
        ]);
        expect(plan?.duplicateCount).toBe(1);
        const reportCall = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls[0];
        expect(normalize(reportCall[0].fsPath)).toBe('/mock/workspace/.autocode/specs/demo/verification/final-report.md');
        expect(Buffer.isBuffer(reportCall[1])).toBe(true);
        expect(vscode.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Final Verification: demo',
            cwd: '/mock/workspace'
        }));
        expect(terminal.sendText).toHaveBeenCalledWith('npm test -- first.test.ts');
        expect(terminal.sendText).toHaveBeenCalledWith('npm run compile');
        const archiveRequest = memoryManager.recordSpecArchive.mock.calls[0][0];
        expect(archiveRequest).toEqual(expect.objectContaining({
            specName: 'demo',
            taskFilePath: '/mock/workspace/.autocode/specs/demo/tasks.md',
            duplicateCheckCount: 1,
            commandChecks: [
                expect.objectContaining({ taskId: '1', value: 'npm test -- first.test.ts' }),
                expect.objectContaining({ taskId: '3', value: 'npm run compile' })
            ]
        }));
        expect(normalize(archiveRequest.requirementsPath)).toBe('/mock/workspace/.autocode/specs/demo/requirements.md');
        expect(normalize(archiveRequest.designPath)).toBe('/mock/workspace/.autocode/specs/demo/design.md');
        expect(normalize(archiveRequest.reportPath)).toBe('/mock/workspace/.autocode/specs/demo/verification/final-report.md');
    });

    test('formats a final verification report with commands and manual checks', () => {
        const report = formatFinalVerificationReport({
            specName: 'demo',
            taskFilePath: '/mock/workspace/.autocode/specs/demo/tasks.md',
            reportPath: '/mock/workspace/.autocode/specs/demo/verification/final-report.md',
            duplicateCount: 0,
            commandItems: [
                {
                    lineNumber: 1,
                    taskId: '1',
                    taskDescription: '1. First task',
                    value: 'npm test -- first.test.ts',
                    kind: 'command'
                }
            ],
            manualItems: [
                {
                    lineNumber: 3,
                    taskId: '2',
                    taskDescription: '2. Manual task',
                    value: 'Manual: inspect panel',
                    kind: 'manual'
                }
            ]
        }, new Date('2026-05-27T00:00:00.000Z'));

        expect(report).toContain('# Final Verification Report');
        expect(report).toContain('| 1 | 2 | `npm test -- first.test.ts` |');
        expect(report).toContain('| 2 | 4 | Manual: inspect panel |');
    });
});

function normalize(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}
