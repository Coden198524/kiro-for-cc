import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderSessionHistory } from '../../../../src/features/spec/providerSessionHistory';

describe('ProviderSessionHistory', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'autocode-session-history-'));
    });

    afterEach(async () => {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    test('finds a Codex implementation session by task prompt terms and avoids verification sessions', async () => {
        const taskFilePath = 'E:\\AITest\\.autocode\\specs\\demo\\tasks.md';
        const taskDescription = '3.2 Implement `Bootstrap`';
        const completionSignalPath = 'E:\\AITest\\.autocode\\specs\\demo\\.autocode\\task-completion-32.json';
        const promptSnapshotPath = path.join(tempDir, 'prompt.md');
        const implementationSessionId = '019e605d-a4f0-7080-97a3-12dbe1d3799f';
        const verificationSessionId = '019e6064-cb2d-7563-8e74-359b00a60c55';

        await fs.promises.writeFile(promptSnapshotPath, [
            'I just completed a spec workflow and now need to implement one of the specific tasks.',
            `Task File Path: ${taskFilePath}`,
            `Task Description: ${taskDescription}`,
            `Completion Signal Path: ${completionSignalPath}`,
            '"runId": "run-32"'
        ].join('\n'));

        await writeCodexSession(implementationSessionId, [
            '<user_input>',
            'I just completed a spec workflow and now need to implement one of the specific tasks.',
            `Task File Path: ${taskFilePath}`,
            'Task Description: 3.2 Implement &#x60;Bootstrap&#x60;',
            `Completion Signal Path: ${completionSignalPath}`,
            '"runId": "run-32"',
            '</user_input>'
        ].join('\n'));
        await writeCodexSession(verificationSessionId, [
            'You are verifying whether a single spec implementation task is truly complete.',
            `Task File: ${taskFilePath}`,
            `Task Description: ${taskDescription}`,
            'Return exactly one JSON object and no markdown.'
        ].join('\n'));

        const history = new ProviderSessionHistory({ homeDir: tempDir });
        const match = await history.findSession({
            providerId: 'codex',
            taskFilePath,
            taskDescription,
            promptSnapshotPath
        });

        expect(match?.sessionId).toBe(implementationSessionId);
        expect(match?.matchedBy).toEqual(expect.arrayContaining([
            'task description',
            'completion signal path',
            'run id'
        ]));
    });

    test('finds a Claude implementation session by task prompt terms', async () => {
        const taskFilePath = 'E:\\AITest\\.autocode\\specs\\demo\\tasks.md';
        const taskDescription = '4.1 Implement Lua runtime';
        const completionSignalPath = 'E:\\AITest\\.autocode\\specs\\demo\\.autocode\\task-completion-41.json';
        const promptSnapshotPath = path.join(tempDir, 'prompt.md');
        const sessionId = 'fb2a3577-96ba-48e7-ad43-8e4e063cbb9a';

        await fs.promises.writeFile(promptSnapshotPath, [
            'I just completed a spec workflow and now need to implement one of the specific tasks.',
            `Task File Path: ${taskFilePath}`,
            `Task Description: ${taskDescription}`,
            `Completion Signal Path: ${completionSignalPath}`
        ].join('\n'));

        const sessionPath = path.join(tempDir, '.claude', 'projects', 'E--AITest', `${sessionId}.jsonl`);
        await fs.promises.mkdir(path.dirname(sessionPath), { recursive: true });
        await fs.promises.writeFile(sessionPath, [
            JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }),
            JSON.stringify({
                type: 'user',
                sessionId,
                message: {
                    role: 'user',
                    content: [
                        'I just completed a spec workflow and now need to implement one of the specific tasks.',
                        `Task File Path: ${taskFilePath}`,
                        `Task Description: ${taskDescription}`,
                        `Completion Signal Path: ${completionSignalPath}`
                    ].join('\n')
                }
            })
        ].join('\n'));

        const history = new ProviderSessionHistory({ homeDir: tempDir });
        const match = await history.findSession({
            providerId: 'claude',
            taskFilePath,
            taskDescription,
            promptSnapshotPath
        });

        expect(match?.sessionId).toBe(sessionId);
        expect(match?.filePath).toBe(sessionPath);
    });

    test('does not match a verification-only session', async () => {
        const taskFilePath = 'E:\\AITest\\.autocode\\specs\\demo\\tasks.md';
        const taskDescription = '5.1 Implement resource mapper';
        const sessionId = '019e6064-cb2d-7563-8e74-359b00a60c55';

        await writeCodexSession(sessionId, [
            'You are verifying whether a single spec implementation task is truly complete.',
            `Task File: ${taskFilePath}`,
            `Task Description: ${taskDescription}`,
            'Return exactly one JSON object and no markdown.'
        ].join('\n'));

        const history = new ProviderSessionHistory({ homeDir: tempDir });
        const match = await history.findSession({
            providerId: 'codex',
            taskFilePath,
            taskDescription
        });

        expect(match).toBeUndefined();
    });

    async function writeCodexSession(sessionId: string, userContent: string): Promise<void> {
        const sessionPath = path.join(
            tempDir,
            '.codex',
            'sessions',
            '2026',
            '05',
            '26',
            `rollout-2026-05-26T02-20-10-${sessionId}.jsonl`
        );
        await fs.promises.mkdir(path.dirname(sessionPath), { recursive: true });
        await fs.promises.writeFile(sessionPath, [
            JSON.stringify({
                timestamp: '2026-05-26T00:00:00.000Z',
                type: 'session_meta',
                payload: { id: sessionId }
            }),
            JSON.stringify({
                timestamp: '2026-05-26T00:00:00.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: userContent }]
                }
            })
        ].join('\n'));
    }
});
