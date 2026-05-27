import * as vscode from 'vscode';
import { IterationManager } from '../../../../src/features/iteration/iterationManager';
import { AgentProviderConfig, AgentRuntime } from '../../../../src/runtime/agentRuntime';
import { PromptLoader } from '../../../../src/services/promptLoader';
import { ConfigManager } from '../../../../src/utils/configManager';
import { SpecDescriptionInput } from '../../../../src/features/spec/specDescriptionInput';

jest.mock('vscode');

describe('IterationManager', () => {
    const provider: AgentProviderConfig = {
        id: 'codex',
        displayName: 'Codex',
        command: 'codex',
        model: 'gpt-5-codex',
        capabilities: {
            permissions: false,
            expertAgents: true,
            claudeAgents: false,
            claudeHooks: false,
            claudeMcp: false,
            extensionMcp: true,
            headless: true,
            interactiveSpecWorkflow: true
        }
    };
    let files: Map<string, Buffer>;
    let capturedPrompt = '';
    let runtime: AgentRuntime;

    beforeEach(() => {
        jest.clearAllMocks();
        (ConfigManager as any).instance = undefined;
        PromptLoader.getInstance().initialize();
        files = new Map();
        capturedPrompt = '';
        runtime = {
            provider,
            refreshProvider: jest.fn(),
            invokeInteractive: jest.fn(async request => {
                capturedPrompt = request.prompt;
                return vscode.window.createTerminal('iteration');
            }),
            invokeHeadless: jest.fn(),
            renameTerminal: jest.fn()
        };

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
        (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(async (uri: vscode.Uri, content: Uint8Array) => {
            files.set(normalize(uri.fsPath), Buffer.from(content));
        });
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
            const normalized = normalize(uri.fsPath);
            if (normalized.endsWith('/.autocode/settings/autocode-settings.json') ||
                normalized.endsWith('/.claude/settings/kfc-settings.json')) {
                throw new Error('missing settings');
            }
            if (normalized.endsWith('/.autocode/steering/product.md')) {
                return Buffer.from('AutoCode is a VS Code extension.');
            }
            const content = files.get(normalized);
            if (!content) {
                throw new Error(`missing file: ${uri.fsPath}`);
            }
            return content;
        });
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([]);
        (vscode.window as any).activeTextEditor = {
            document: {
                uri: vscode.Uri.file('/mock/workspace/src/example.ts'),
                languageId: 'typescript',
                getText: jest.fn((selection?: unknown) => selection ? 'const selected = true;' : 'const fullFile = true;')
            },
            selection: { isEmpty: false }
        };
        (vscode.languages.getDiagnostics as jest.Mock).mockReturnValue([
            {
                message: 'Type mismatch',
                source: 'ts',
                range: {
                    start: { line: 4 }
                }
            }
        ]);
        jest.spyOn(SpecDescriptionInput, 'prompt').mockResolvedValue('修复按钮不触发的问题');
    });

    test('starts a lightweight edit iteration with project context and session files', async () => {
        const memoryManager = {
            buildPromptContext: jest.fn(async () => 'Remember to keep changes focused.')
        };
        const manager = new IterationManager(runtime, vscode.window.createOutputChannel('test'), memoryManager as any);

        const record = await manager.start({ mode: 'edit' });

        expect(record?.mode).toBe('edit');
        expect(runtime.refreshProvider).toHaveBeenCalled();
        expect(runtime.invokeInteractive).toHaveBeenCalledWith(expect.objectContaining({
            title: expect.stringContaining('Iteration: Edit / Fix'),
            agentType: 'task_implementer',
            reuseTerminal: false
        }));
        expect(capturedPrompt).toContain('Iteration mode: Edit / Fix (edit)');
        expect(capturedPrompt).toContain('修复按钮不触发的问题');
        expect(capturedPrompt).toContain('const selected = true;');
        expect(capturedPrompt).toContain('line 5: [ts] Type mismatch');
        expect(capturedPrompt).toContain('AutoCode is a VS Code extension.');
        expect(capturedPrompt).toContain('Remember to keep changes focused.');
        expect(capturedPrompt).toContain('Do not create requirements.md, design.md, tasks.md, or a new spec');

        const writtenPaths = [...files.keys()];
        expect(writtenPaths.some(filePath => filePath.endsWith('.prompt.md'))).toBe(true);
        expect(writtenPaths.some(filePath => filePath.endsWith('.json'))).toBe(true);

        const recordPath = writtenPaths.find(filePath => filePath.endsWith('.json'))!;
        const storedRecord = JSON.parse(files.get(recordPath)!.toString());
        expect(storedRecord.mode).toBe('edit');
        expect(storedRecord.provider).toBe('Codex');
        expect(storedRecord.activeFilePath).toBe('/mock/workspace/src/example.ts');
    });

    test('lists recent iteration records newest first', async () => {
        const older = createRecord('old', '2026-05-26T00:00:00.000Z');
        const newer = createRecord('new', '2026-05-27T00:00:00.000Z');
        files.set('/mock/workspace/.autocode/iterations/old.json', Buffer.from(JSON.stringify(older)));
        files.set('/mock/workspace/.autocode/iterations/new.json', Buffer.from(JSON.stringify(newer)));
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
            ['old.json', vscode.FileType.File],
            ['new.json', vscode.FileType.File],
            ['new.prompt.md', vscode.FileType.File]
        ]);

        const manager = new IterationManager(runtime, vscode.window.createOutputChannel('test'));
        const records = await manager.listRecent();

        expect(records.map(record => record.id)).toEqual(['new', 'old']);
    });

    test('builds a spec seed from an iteration request and summary', async () => {
        const record = createRecord('convert', '2026-05-27T00:00:00.000Z');
        files.set(record.summaryPath, Buffer.from('The iteration found that this needs queue design changes.'));
        const manager = new IterationManager(runtime, vscode.window.createOutputChannel('test'));

        const description = await manager.buildSpecDescription(record as any);

        expect(description).toContain('Create a full AutoCode Spec from this lightweight iteration.');
        expect(description).toContain('Original iteration request:');
        expect(description).toContain('convert');
        expect(description).toContain('Iteration summary:');
        expect(description).toContain('queue design changes');
        expect(description).toContain('Prompt file:');
    });

    test('continues a previous iteration using saved summary context', async () => {
        const record = createRecord('continue', '2026-05-27T00:00:00.000Z');
        files.set(record.summaryPath, Buffer.from('Previous run identified a narrow queue bug.'));
        const manager = new IterationManager(runtime, vscode.window.createOutputChannel('test'));

        const continued = await manager.continue(record as any);

        expect(continued?.mode).toBe('ask');
        expect(runtime.invokeInteractive).toHaveBeenCalled();
        expect(capturedPrompt).toContain('Continue this previous AutoCode iteration.');
        expect(capturedPrompt).toContain('Previous run identified a narrow queue bug.');
    });
});

function createRecord(id: string, startedAt: string) {
    return {
        id,
        title: id,
        mode: 'ask',
        description: id,
        workspacePath: '/mock/workspace',
        promptPath: `/mock/workspace/.autocode/iterations/${id}.prompt.md`,
        summaryPath: `/mock/workspace/.autocode/iterations/${id}.summary.md`,
        recordPath: `/mock/workspace/.autocode/iterations/${id}.json`,
        provider: 'Codex',
        startedAt
    };
}

function normalize(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}
